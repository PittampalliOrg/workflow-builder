"""Content-addressed durable transcript storage on the agent workspace PVC."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from src.ports.durable_history import (
    DurableHistoryBudgetError,
    DurableHistoryIntegrityError,
    DurableHistoryInvalidReferenceError,
    DurableHistorySerializationError,
)

_HISTORY_SCHEME = "history+sha256"
_MESSAGE_SCHEME = "message+sha256"
_DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_HISTORY_REF_PATTERN = re.compile(r"^history\+sha256://([0-9a-f]{64})$")
_MESSAGE_REF_PATTERN = re.compile(r"^message\+sha256://([0-9a-f]{64})$")
_HISTORY_SCHEMA = "workflow-builder.pydantic-ai.durable-history/v1"
_MESSAGE_SCHEMA = "workflow-builder.pydantic-ai.durable-message/v1"


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _validate_json_value(value: Any, *, location: str = "$") -> None:
    """Reject Python values whose JSON round trip would change their meaning."""

    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise DurableHistorySerializationError(
                f"{location} contains a non-finite number"
            )
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _validate_json_value(item, location=f"{location}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise DurableHistorySerializationError(
                    f"{location} contains a non-string object key"
                )
            _validate_json_value(item, location=f"{location}.{key}")
        return
    raise DurableHistorySerializationError(
        f"{location} contains unsupported JSON value {type(value).__name__}"
    )


def _canonical_json(value: Any) -> bytes:
    try:
        _validate_json_value(value)
        return json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except DurableHistorySerializationError:
        raise
    except (RecursionError, TypeError, UnicodeEncodeError, ValueError) as exc:
        raise DurableHistorySerializationError(
            "value cannot be encoded as canonical JSON"
        ) from exc


class FilesystemDurableHistoryAdapter:
    """Store immutable message blobs and ordered transcript manifests."""

    def __init__(self, workspace_root: str | Path, *, max_bytes: int) -> None:
        if (
            isinstance(max_bytes, bool)
            or not isinstance(max_bytes, int)
            or max_bytes < 1
        ):
            raise ValueError("durable transcript max_bytes must be a positive integer")

        workspace = Path(workspace_root).resolve()
        storage_root = workspace / ".pydantic-ai" / "durable-history"
        storage_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        resolved_storage_root = storage_root.resolve()
        if not resolved_storage_root.is_relative_to(workspace):
            raise ValueError(
                "durable transcript storage must remain inside workspace_root"
            )

        self._root = resolved_storage_root
        self._messages = self._root / "messages"
        self._manifests = self._root / "manifests"
        self._messages.mkdir(mode=0o700, exist_ok=True)
        self._manifests.mkdir(mode=0o700, exist_ok=True)
        self._max_bytes = max_bytes

    @staticmethod
    def _reference(scheme: str, digest: str) -> str:
        return f"{scheme}://{digest}"

    @staticmethod
    def _parse_reference(reference: str, *, history: bool) -> str:
        if not isinstance(reference, str):
            raise DurableHistoryInvalidReferenceError(
                "durable history reference must be a string"
            )
        pattern = _HISTORY_REF_PATTERN if history else _MESSAGE_REF_PATTERN
        match = pattern.fullmatch(reference)
        if match is None:
            kind = "history" if history else "message"
            raise DurableHistoryInvalidReferenceError(
                f"invalid durable {kind} reference"
            )
        return match.group(1)

    @staticmethod
    def _atomic_write(path: Path, payload: bytes) -> None:
        if path.exists() and not path.is_symlink():
            try:
                if path.read_bytes() == payload:
                    return
            except OSError:
                pass

        descriptor, temporary_name = tempfile.mkstemp(
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
        )
        temporary_path = Path(temporary_name)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, path)
        finally:
            temporary_path.unlink(missing_ok=True)

    @staticmethod
    def _read_verified(path: Path, digest: str, *, kind: str) -> bytes:
        if not _DIGEST_PATTERN.fullmatch(digest):
            raise DurableHistoryInvalidReferenceError(f"invalid durable {kind} digest")
        if path.is_symlink():
            raise DurableHistoryIntegrityError(
                f"durable {kind} object must not be a symbolic link"
            )
        try:
            payload = path.read_bytes()
        except FileNotFoundError as exc:
            raise DurableHistoryIntegrityError(
                f"durable {kind} object is unavailable"
            ) from exc
        actual_digest = _sha256(payload)
        if actual_digest != digest:
            raise DurableHistoryIntegrityError(
                f"durable {kind} sha256 mismatch: expected {digest}, got {actual_digest}"
            )
        return payload

    @staticmethod
    def _decode_canonical_object(payload: bytes, *, kind: str) -> dict[str, Any]:
        try:
            value = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DurableHistoryIntegrityError(
                f"durable {kind} object is not valid JSON"
            ) from exc
        if not isinstance(value, dict):
            raise DurableHistoryIntegrityError(
                f"durable {kind} object must be a JSON object"
            )
        try:
            canonical = _canonical_json(value)
        except DurableHistorySerializationError as exc:
            raise DurableHistoryIntegrityError(
                f"durable {kind} object contains unsupported JSON"
            ) from exc
        if canonical != payload:
            raise DurableHistoryIntegrityError(
                f"durable {kind} object is not canonical JSON"
            )
        return value

    def _check_budget(self, actual_bytes: int) -> None:
        if actual_bytes > self._max_bytes:
            raise DurableHistoryBudgetError(
                actual_bytes=actual_bytes,
                max_bytes=self._max_bytes,
            )

    def _encode_message(self, message: dict[str, Any]) -> tuple[bytes, str]:
        if not isinstance(message, dict):
            raise DurableHistorySerializationError(
                "durable transcript messages must be JSON objects"
            )
        self._check_budget(len(_canonical_json([message])))
        envelope = {
            "message": message,
            "schema": _MESSAGE_SCHEMA,
        }
        payload = _canonical_json(envelope)
        return payload, _sha256(payload)

    def save_message(self, message: dict[str, Any]) -> str:
        payload, digest = self._encode_message(message)
        self._atomic_write(self._messages / f"{digest}.json", payload)
        return self._reference(_MESSAGE_SCHEME, digest)

    def load_message(self, reference: str) -> dict[str, Any]:
        digest = self._parse_reference(reference, history=False)
        payload = self._read_verified(
            self._messages / f"{digest}.json",
            digest,
            kind="message",
        )
        envelope = self._decode_canonical_object(payload, kind="message")
        if (
            set(envelope) != {"message", "schema"}
            or envelope.get("schema") != _MESSAGE_SCHEMA
        ):
            raise DurableHistoryIntegrityError(
                "durable message object has an unsupported schema"
            )
        message = envelope.get("message")
        if not isinstance(message, dict):
            raise DurableHistoryIntegrityError(
                "durable message object is missing its message"
            )
        try:
            self._check_budget(len(_canonical_json([message])))
        except DurableHistorySerializationError as exc:
            raise DurableHistoryIntegrityError(
                "durable message object contains unsupported JSON"
            ) from exc
        return message

    def save(self, messages: list[dict[str, Any]]) -> str:
        if not isinstance(messages, list):
            raise DurableHistorySerializationError(
                "durable transcript must be a message list"
            )
        if any(not isinstance(message, dict) for message in messages):
            raise DurableHistorySerializationError(
                "durable transcript messages must be JSON objects"
            )

        transcript_payload = _canonical_json(messages)
        self._check_budget(len(transcript_payload))

        encoded_messages = [self._encode_message(message) for message in messages]
        message_refs: list[str] = []
        for payload, digest in encoded_messages:
            self._atomic_write(self._messages / f"{digest}.json", payload)
            message_refs.append(self._reference(_MESSAGE_SCHEME, digest))

        manifest = {
            "messageRefs": message_refs,
            "schema": _HISTORY_SCHEMA,
            "transcriptSha256": _sha256(transcript_payload),
            "transcriptSizeBytes": len(transcript_payload),
        }
        manifest_payload = _canonical_json(manifest)
        manifest_digest = _sha256(manifest_payload)
        self._atomic_write(
            self._manifests / f"{manifest_digest}.json",
            manifest_payload,
        )
        return self._reference(_HISTORY_SCHEME, manifest_digest)

    def load(self, reference: str) -> list[dict[str, Any]]:
        digest = self._parse_reference(reference, history=True)
        payload = self._read_verified(
            self._manifests / f"{digest}.json",
            digest,
            kind="history manifest",
        )
        manifest = self._decode_canonical_object(payload, kind="history manifest")
        if (
            set(manifest)
            != {
                "messageRefs",
                "schema",
                "transcriptSha256",
                "transcriptSizeBytes",
            }
            or manifest.get("schema") != _HISTORY_SCHEMA
        ):
            raise DurableHistoryIntegrityError(
                "durable history manifest has an unsupported schema"
            )

        message_refs = manifest.get("messageRefs")
        expected_digest = manifest.get("transcriptSha256")
        expected_size = manifest.get("transcriptSizeBytes")
        if (
            not isinstance(message_refs, list)
            or any(not isinstance(item, str) for item in message_refs)
            or not isinstance(expected_digest, str)
            or _DIGEST_PATTERN.fullmatch(expected_digest) is None
            or isinstance(expected_size, bool)
            or not isinstance(expected_size, int)
            or expected_size < 0
        ):
            raise DurableHistoryIntegrityError(
                "durable history manifest contains invalid metadata"
            )
        self._check_budget(expected_size)

        messages = [self.load_message(item) for item in message_refs]
        transcript_payload = _canonical_json(messages)
        actual_size = len(transcript_payload)
        self._check_budget(actual_size)
        if actual_size != expected_size:
            raise DurableHistoryIntegrityError(
                "durable transcript size does not match its manifest"
            )
        actual_digest = _sha256(transcript_payload)
        if actual_digest != expected_digest:
            raise DurableHistoryIntegrityError(
                "durable transcript sha256 does not match its manifest"
            )
        return messages
