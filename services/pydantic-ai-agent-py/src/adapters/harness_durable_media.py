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

from pydantic_ai import BinaryContent
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

    async def _externalize_content(self, value: Any) -> Any:
        if isinstance(value, BinaryContent):
            uri = await self._store.put(
                value.data,
                context=MediaContext(media_type=value.media_type),
            )
            return {
                _MEDIA_ENVELOPE: {
                    "uri": uri,
                    "size_bytes": len(value.data),
                    "media_type": value.media_type,
                    "identifier": value.identifier,
                    "vendor_metadata": value.vendor_metadata,
                }
            }
        if isinstance(value, (list, tuple)):
            return [await self._externalize_content(item) for item in value]
        if isinstance(value, dict):
            encoded = {
                str(key): await self._externalize_content(item)
                for key, item in value.items()
            }
            if _MEDIA_ENVELOPE in value or _JSON_ENVELOPE in value:
                return {_JSON_ENVELOPE: list(encoded.items())}
            return encoded
        return value

    async def externalize(self, node: Any) -> list[dict[str, Any]]:
        """Externalize typed ModelMessages and return their durable JSON form."""
        if not isinstance(node, list):
            raise TypeError("durable media externalize expects a ModelMessage list")
        messages: list[ModelMessage] = []
        for message in node:
            if not isinstance(message, ModelRequest):
                messages.append(message)
                continue
            parts: list[Any] = []
            for part in message.parts:
                if isinstance(part, (ToolReturnPart, UserPromptPart)) and not isinstance(
                    part.content, str
                ):
                    part = replace(
                        part,
                        content=await self._externalize_content(part.content),
                    )
                parts.append(part)
            messages.append(replace(message, parts=parts))
        return dump_messages(messages)

    async def _restore_media_envelope(self, payload: Any, expected_size: int) -> Any:
        if not isinstance(payload, dict):
            raise ValueError("external media envelope payload must be an object")
        uri = payload.get("uri")
        media_type = payload.get("media_type")
        if not isinstance(uri, str) or not isinstance(media_type, str):
            raise ValueError("external media envelope is missing uri or media_type")
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
            "identifier": payload.get("identifier"),
        }

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
        if set(value) == {_JSON_ENVELOPE}:
            pairs = value[_JSON_ENVELOPE]
            if not isinstance(pairs, list):
                raise ValueError("escaped tool JSON envelope must contain key/value pairs")
            restored_json: dict[str, Any] = {}
            for pair in pairs:
                if (
                    not isinstance(pair, list)
                    or len(pair) != 2
                    or not isinstance(pair[0], str)
                ):
                    raise ValueError("escaped tool JSON envelope contains an invalid pair")
                restored_json[pair[0]] = await self._restore_content(
                    pair[1],
                    restore_all=restore_all,
                    seen_budget=seen_budget,
                    request_budget=request_budget,
                )
            return restored_json
        if set(value) == {_MEDIA_ENVELOPE}:
            if not restore_all:
                if seen_budget[0] <= 0:
                    return _OMITTED_MEDIA
            payload = value[_MEDIA_ENVELOPE]
            if not isinstance(payload, dict):
                raise ValueError("external media envelope payload must be an object")
            size = payload.get("size_bytes")
            if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
                raise ValueError("external media envelope has an invalid size_bytes")
            if (
                request_budget["images"] <= 0
                or size > request_budget["bytes"]
            ):
                return (
                    "[image not admitted to this model request: aggregate media "
                    "limit reached; invoke its originating media tool again in a "
                    "later turn]"
                )
            request_budget["images"] -= 1
            request_budget["bytes"] -= size
            if not restore_all:
                seen_budget[0] -= 1
            return await self._restore_media_envelope(payload, size)
        restored_dict: dict[str, Any] = {}
        for key, item in reversed(list(value.items())):
            restored_dict[key] = await self._restore_content(
                item,
                restore_all=restore_all,
                seen_budget=seen_budget,
                request_budget=request_budget,
            )
        return {key: restored_dict[key] for key in value}

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
        return load_messages(raw)
