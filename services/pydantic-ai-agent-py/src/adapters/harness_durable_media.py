"""Typed Pydantic message adapter backed by the Harness media store.

Only actual ``BinaryContent`` instances are externalized. Ordinary tool JSON is
escaped when it collides with the adapter envelope, so a tool cannot be
misclassified as media merely by returning a ``kind=binary`` shaped object.
"""

from __future__ import annotations

import base64
import copy
import hashlib
from dataclasses import replace
from pathlib import Path
from typing import Any

from pydantic_ai import BinaryContent, ImageUrl
from pydantic_ai.messages import ModelMessage, ModelRequest, ToolReturnPart, UserPromptPart
from pydantic_ai_harness.media import DiskMediaStore, MediaContext, parse_media_uri

from src.messages_io import dump_messages, load_messages

_MEDIA_ENVELOPE = "__wfb_external_media_v1__"
_JSON_ENVELOPE = "__wfb_escaped_media_json_v1__"
_OMITTED_MEDIA = (
    "[older image omitted from model history; invoke its originating media tool again if needed]"
)


class HarnessDurableMediaAdapter:
    """DurableMediaPort backed by a content-addressed workspace directory."""

    def __init__(self, workspace_root: str | Path) -> None:
        root = Path(workspace_root).resolve()
        self._store = DiskMediaStore(root / ".pydantic-ai" / "media")

    async def _externalize_content(
        self,
        typed: Any,
        serialized: Any,
        *,
        preserve_references: bool,
    ) -> Any:
        if isinstance(typed, BinaryContent):
            uri = await self._store.put(
                typed.data,
                context=MediaContext(media_type=typed.media_type),
            )
            sentinel = ImageUrl(
                url=uri,
                media_type=typed.media_type,
                identifier=typed.identifier,
                vendor_metadata={
                    _MEDIA_ENVELOPE: {
                        "size_bytes": len(typed.data),
                        "vendor_metadata": typed.vendor_metadata,
                    }
                },
            )
            return {
                "url": sentinel.url,
                "force_download": sentinel.force_download,
                "vendor_metadata": sentinel.vendor_metadata,
                "kind": sentinel.kind,
                "media_type": sentinel.media_type,
                "identifier": sentinel.identifier,
            }
        if isinstance(typed, (list, tuple)) and isinstance(serialized, list):
            if len(typed) != len(serialized):
                raise ValueError("serialized media sequence length changed")
            return [
                await self._externalize_content(
                    item,
                    raw_item,
                    preserve_references=preserve_references,
                )
                for item, raw_item in zip(typed, serialized, strict=True)
            ]
        if isinstance(typed, dict) and isinstance(serialized, dict):
            if preserve_references and (
                self._media_marker(serialized) is not None
                or self._escaped_json_envelope(serialized)
            ):
                return serialized
            encoded = {
                str(key): await self._externalize_content(
                    item,
                    serialized.get(str(key)),
                    preserve_references=preserve_references,
                )
                for key, item in typed.items()
            }
            vendor_metadata = typed.get("vendor_metadata")
            if (
                _MEDIA_ENVELOPE in typed
                or _JSON_ENVELOPE in typed
                or (
                    isinstance(vendor_metadata, dict)
                    and _MEDIA_ENVELOPE in vendor_metadata
                )
            ):
                return {
                    _JSON_ENVELOPE: [[key, value] for key, value in encoded.items()]
                }
            return encoded
        return serialized

    async def externalize(
        self, node: Any, *, preserve_references: bool = False
    ) -> list[dict[str, Any]]:
        """Externalize typed ModelMessages and return their durable JSON form."""
        if not isinstance(node, list):
            raise TypeError("durable media externalize expects a ModelMessage list")
        serialized_messages = dump_messages(node)
        for message, serialized_message in zip(
            node, serialized_messages, strict=True
        ):
            if not isinstance(message, ModelRequest):
                continue
            serialized_parts = serialized_message.get("parts")
            if not isinstance(serialized_parts, list):
                raise ValueError("serialized model request is missing parts")
            for part, serialized_part in zip(
                message.parts, serialized_parts, strict=True
            ):
                if isinstance(part, (ToolReturnPart, UserPromptPart)) and not isinstance(
                    part.content, str
                ):
                    serialized_part["content"] = await self._externalize_content(
                        part.content,
                        serialized_part.get("content"),
                        preserve_references=preserve_references,
                    )
        return serialized_messages

    async def _restore_media_envelope(
        self, sentinel: dict[str, Any], payload: Any, expected_size: int
    ) -> Any:
        if not isinstance(payload, dict):
            raise ValueError("external media marker payload must be an object")
        uri = sentinel.get("url")
        media_type = sentinel.get("media_type")
        if not isinstance(uri, str) or not isinstance(media_type, str):
            raise ValueError("external media sentinel is missing url or media_type")
        raw = await self._store.get(uri)
        if len(raw) != expected_size:
            raise ValueError(
                f"durable media size check failed for {uri}: expected "
                f"{expected_size}, got {len(raw)}"
            )
        expected = parse_media_uri(uri)
        actual = hashlib.sha256(raw).hexdigest()
        if actual != expected:
            raise ValueError(
                f"durable media integrity check failed for {uri}: got sha256 {actual}"
            )
        return {
            "data": base64.urlsafe_b64encode(raw).decode("ascii"),
            "media_type": media_type,
            "vendor_metadata": payload.get("vendor_metadata"),
            "kind": "binary",
            "identifier": sentinel.get("identifier"),
        }

    @staticmethod
    def _media_marker(value: dict[str, Any]) -> dict[str, Any] | None:
        if value.get("kind") != "image-url":
            return None
        uri = value.get("url")
        vendor_metadata = value.get("vendor_metadata")
        if not isinstance(uri, str) or not uri.startswith("media+sha256://"):
            return None
        if not isinstance(vendor_metadata, dict) or set(vendor_metadata) != {
            _MEDIA_ENVELOPE
        }:
            return None
        marker = vendor_metadata[_MEDIA_ENVELOPE]
        if not isinstance(marker, dict) or set(marker) != {
            "size_bytes",
            "vendor_metadata",
        }:
            return None
        return marker

    @staticmethod
    def _escaped_json_envelope(value: dict[str, Any]) -> bool:
        if set(value) != {_JSON_ENVELOPE}:
            return False
        pairs = value[_JSON_ENVELOPE]
        return isinstance(pairs, list) and all(
            isinstance(pair, list)
            and len(pair) == 2
            and isinstance(pair[0], str)
            for pair in pairs
        )

    async def _restore_content(
        self,
        value: Any,
        *,
        restore_all: bool,
        seen_budget: list[int],
        request_budget: dict[str, int],
    ) -> Any:
        if isinstance(value, list):
            restored: list[Any] = [None] * len(value)
            indexes = (
                range(len(value))
                if restore_all
                else range(len(value) - 1, -1, -1)
            )
            for index in indexes:
                restored[index] = await self._restore_content(
                    value[index],
                    restore_all=restore_all,
                    seen_budget=seen_budget,
                    request_budget=request_budget,
                )
            return restored
        if not isinstance(value, dict):
            return value
        media_marker = self._media_marker(value)
        if media_marker is not None:
            size = media_marker.get("size_bytes")
            if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
                raise ValueError("external media sentinel has an invalid size_bytes")
            if not restore_all and seen_budget[0] <= 0:
                return _OMITTED_MEDIA
            if request_budget["images"] <= 0 or size > request_budget["bytes"]:
                return (
                    "[image not admitted to this model request: aggregate media "
                    "limit reached; invoke its originating media tool again in a "
                    "later turn]"
                )
            request_budget["images"] -= 1
            request_budget["bytes"] -= size
            if not restore_all:
                seen_budget[0] -= 1
            return await self._restore_media_envelope(value, media_marker, size)
        if set(value) == {_JSON_ENVELOPE}:
            pairs = value[_JSON_ENVELOPE]
            if not isinstance(pairs, list):
                raise ValueError("escaped tool JSON envelope must contain key/value pairs")
            restored_pairs: list[list[Any]] = []
            for pair in pairs:
                if (
                    not isinstance(pair, list)
                    or len(pair) != 2
                    or not isinstance(pair[0], str)
                ):
                    raise ValueError("escaped tool JSON envelope contains an invalid pair")
                restored_pairs.append(
                    [
                        pair[0],
                        await self._restore_content(
                            pair[1],
                            restore_all=restore_all,
                            seen_budget=seen_budget,
                            request_budget=request_budget,
                        ),
                    ]
                )
            # Keep the wrapper through Pydantic's discriminated-union parse;
            # otherwise ordinary JSON shaped like ImageUrl is coerced to media.
            return {_JSON_ENVELOPE: restored_pairs}
        restored_dict: dict[str, Any] = {}
        for key, item in reversed(list(value.items())):
            restored_dict[key] = await self._restore_content(
                item,
                restore_all=restore_all,
                seen_budget=seen_budget,
                request_budget=request_budget,
            )
        return {key: restored_dict[key] for key in value}

    @classmethod
    def _decode_json_envelopes(cls, value: Any) -> Any:
        if isinstance(value, list):
            return [cls._decode_json_envelopes(item) for item in value]
        if isinstance(value, tuple):
            return tuple(cls._decode_json_envelopes(item) for item in value)
        if not isinstance(value, dict):
            return value
        if set(value) == {_JSON_ENVELOPE}:
            pairs = value[_JSON_ENVELOPE]
            if not isinstance(pairs, list):
                raise ValueError("escaped tool JSON envelope must contain key/value pairs")
            decoded: dict[str, Any] = {}
            for pair in pairs:
                if (
                    not isinstance(pair, list)
                    or len(pair) != 2
                    or not isinstance(pair[0], str)
                ):
                    raise ValueError(
                        "escaped tool JSON envelope contains an invalid pair"
                    )
                decoded[pair[0]] = cls._decode_json_envelopes(pair[1])
            return decoded
        return {
            str(key): cls._decode_json_envelopes(item)
            for key, item in value.items()
        }

    async def restore(
        self,
        node: Any,
        *,
        max_media_items: int | None = None,
        max_request_images: int | None = None,
        max_request_bytes: int | None = None,
    ) -> list[ModelMessage]:
        """Restore every unseen image, then at most N previously seen images."""
        if not isinstance(node, list):
            raise TypeError("durable media restore expects serialized ModelMessages")
        raw = copy.deepcopy(node)
        last_response = max(
            (
                index
                for index, message in enumerate(raw)
                if isinstance(message, dict) and message.get("kind") == "response"
            ),
            default=-1,
        )
        budget = [max(0, max_media_items)] if max_media_items is not None else [0]
        request_budget = {
            "images": (
                max(0, max_request_images)
                if max_request_images is not None
                else 2**31
            ),
            "bytes": (
                max(0, max_request_bytes)
                if max_request_bytes is not None
                else 2**63
            ),
        }
        indexes = [
            *range(last_response + 1, len(raw)),
            *range(last_response, -1, -1),
        ]
        for index in indexes:
            message = raw[index]
            if not isinstance(message, dict):
                continue
            parts = message.get("parts")
            if not isinstance(parts, list):
                continue
            restore_all = max_media_items is None or index > last_response
            part_iter = parts if restore_all else reversed(parts)
            for part in part_iter:
                if not isinstance(part, dict) or part.get("part_kind") not in {
                    "tool-return",
                    "user-prompt",
                }:
                    continue
                if "content" in part and not isinstance(part["content"], str):
                    part["content"] = await self._restore_content(
                        part["content"],
                        restore_all=restore_all,
                        seen_budget=budget,
                        request_budget=request_budget,
                    )
        restored = load_messages(raw)
        decoded: list[ModelMessage] = []
        for message in restored:
            if not isinstance(message, ModelRequest):
                decoded.append(message)
                continue
            parts = []
            for part in message.parts:
                if isinstance(part, (ToolReturnPart, UserPromptPart)) and not isinstance(
                    part.content, str
                ):
                    part = replace(
                        part,
                        content=self._decode_json_envelopes(part.content),
                    )
                parts.append(part)
            decoded.append(replace(message, parts=parts))
        return decoded
