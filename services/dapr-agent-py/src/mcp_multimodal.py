"""Preserve MCP visual tool results across the string-only Dapr state schema.

``dapr-agents`` serializes ``CallToolResult`` values into string-only
``ToolMessage.content``. Depending on the input shape, images become opaque JSON
text or are discarded while extracting text blocks. Encode only the supported
multimodal content behind a private marker so provider adapters can recover it
without teaching the shared Dapr state models a provider-specific content type.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
import json
from typing import Any, Callable

from src.ports.multimodal_media import MultimodalMediaOffloadPort


_MARKER = "__wfb_multimodal_tool_result__"
_MARKER_VERSION = 1
_MEDIA_TYPES = {
    "image",
    "image_url",
    "input_image",
    "video",
    "video_url",
    "input_video",
}


@dataclass(frozen=True)
class SerializedMcpToolResult:
    display_text: str
    durable_content: str
    media_count: int = 0

    @property
    def is_multimodal(self) -> bool:
        return self.media_count > 0


def _mapping(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            dumped = model_dump(by_alias=True, exclude_none=True)
        except TypeError:
            dumped = model_dump()
        return dumped if isinstance(dumped, dict) else None
    return None


def _decode_json_mapping(value: Any) -> dict[str, Any] | None:
    parsed = value
    for _ in range(2):
        mapped = _mapping(parsed)
        if mapped is not None:
            return mapped
        if not isinstance(parsed, str):
            return None
        try:
            parsed = json.loads(parsed)
        except (TypeError, ValueError, json.JSONDecodeError):
            return None
    return _mapping(parsed)


def _content_block(value: Any) -> dict[str, Any] | None:
    block = _mapping(value)
    if block is None:
        return None
    block_type = str(block.get("type") or "").strip()
    if block_type == "text" and isinstance(block.get("text"), str):
        return {"type": "text", "text": block["text"]}
    if block_type in {"image", "input_image"}:
        data = block.get("data")
        if not isinstance(data, str) or not data:
            return None
        media_type = (
            block.get("mimeType") or block.get("mediaType") or block.get("media_type")
        )
        normalized: dict[str, Any] = {"type": block_type, "data": data}
        if isinstance(media_type, str) and media_type:
            normalized["mimeType"] = media_type
        return normalized
    if block_type in {"image_url", "video_url", "video", "input_video"}:
        key = "image_url" if "image" in block_type else "video_url"
        url = block.get(key)
        if isinstance(url, (str, dict)):
            return {"type": block_type, key: url}
        source = block.get("source")
        if isinstance(source, dict):
            return {"type": block_type, "source": source}
    return None


def _encode_content(parts: list[dict[str, Any]]) -> str:
    return json.dumps(
        {_MARKER: _MARKER_VERSION, "content": parts},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _inline_image(
    block: dict[str, Any],
) -> tuple[bytes, str] | None:
    """Return decoded inline image bytes, or ``None`` for provider references."""
    block_type = str(block.get("type") or "")
    data: str | None = None
    media_type: str | None = None
    if block_type in {"image", "input_image"}:
        raw_data = block.get("data")
        if isinstance(raw_data, str) and raw_data:
            data = raw_data
            media_type = str(
                block.get("mimeType")
                or block.get("mediaType")
                or block.get("media_type")
                or "image/png"
            )
    elif block_type == "image_url":
        raw_image_url = block.get("image_url")
        if isinstance(raw_image_url, dict):
            candidate = str(raw_image_url.get("url") or "")
        else:
            candidate = str(raw_image_url or "")
        if not candidate.startswith("data:"):
            return None
        header, separator, data = candidate.partition(",")
        if not separator or ";base64" not in header.lower():
            raise ValueError("Inline image URL must contain base64 image data")
        media_type = header[5:].split(";", 1)[0]

    if data is None or media_type is None:
        return None
    try:
        decoded = base64.b64decode(data, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError(
            "Multimodal tool result contains invalid base64 image data"
        ) from exc
    return decoded, media_type.strip().lower()


def offload_multimodal_content(
    value: Any,
    media_offloader: MultimodalMediaOffloadPort,
) -> str | None:
    """Replace inline marker images with compact provider-readable references."""
    parts = decode_multimodal_tool_content(value)
    if parts is None:
        return None

    changed = False
    durable_parts: list[dict[str, Any]] = []
    for part in parts:
        inline = _inline_image(part)
        if inline is None:
            durable_parts.append(part)
            continue
        image, media_type = inline
        reference = media_offloader.upload_image(image, media_type)
        durable_parts.append({"type": "image_url", "image_url": {"url": reference.uri}})
        changed = True
    return _encode_content(durable_parts) if changed else _encode_content(parts)


def offload_multimodal_tool_result(
    value: Any,
    media_offloader: MultimodalMediaOffloadPort,
) -> Any:
    """Return a tool result copy whose marker contains no inline image bytes."""
    if not isinstance(value, dict) or not isinstance(value.get("content"), str):
        return value
    durable_content = offload_multimodal_content(value["content"], media_offloader)
    if durable_content is None:
        return value
    offloaded = dict(value)
    offloaded["content"] = durable_content
    return offloaded


def decode_multimodal_tool_content(value: Any) -> list[dict[str, Any]] | None:
    """Decode a marker produced by :func:`serialize_mcp_tool_result`."""
    envelope = _decode_json_mapping(value)
    if envelope is None or envelope.get(_MARKER) != _MARKER_VERSION:
        return None
    raw_content = envelope.get("content")
    if not isinstance(raw_content, list):
        return None
    parts = [part for item in raw_content if (part := _content_block(item))]
    return parts if any(part.get("type") in _MEDIA_TYPES for part in parts) else None


def is_multimodal_tool_content(value: Any) -> bool:
    return decode_multimodal_tool_content(value) is not None


def multimodal_tool_text(value: Any) -> str | None:
    parts = decode_multimodal_tool_content(value)
    if parts is None:
        return None
    text = "\n".join(
        str(part.get("text") or "") for part in parts if part.get("type") == "text"
    ).strip()
    return text or "[visual media returned by tool]"


def replace_multimodal_tool_text(value: Any, text: str) -> str | None:
    parts = decode_multimodal_tool_content(value)
    if parts is None:
        return None
    media = [part for part in parts if part.get("type") in _MEDIA_TYPES]
    return _encode_content([{"type": "text", "text": text}, *media])


def redact_multimodal_tool_result(value: Any) -> Any:
    """Return an observability-safe copy with image bytes removed."""
    if not isinstance(value, dict):
        return value
    parts = decode_multimodal_tool_content(value.get("content"))
    if parts is None:
        return value
    media_count = sum(part.get("type") in _MEDIA_TYPES for part in parts)
    redacted = dict(value)
    redacted["content"] = (
        f"{multimodal_tool_text(value.get('content'))}\n"
        f"[{media_count} visual media block(s) omitted from telemetry]"
    )
    return redacted


def serialize_mcp_tool_result(
    result: Any,
    fallback_serializer: Callable[[Any], str],
    *,
    media_offloader: MultimodalMediaOffloadPort | None = None,
) -> SerializedMcpToolResult:
    """Serialize an MCP result while retaining successful visual content once."""
    envelope = _decode_json_mapping(result)
    is_mcp_envelope = envelope is not None and (
        "isError" in envelope or "is_error" in envelope
    )
    if not is_mcp_envelope:
        serialized = fallback_serializer(result)
        return SerializedMcpToolResult(serialized, serialized)

    raw_content = envelope.get("content")
    if not isinstance(raw_content, list):
        serialized = (
            "MCP tool call failed: no content blocks"
            if envelope.get("isError") or envelope.get("is_error")
            else fallback_serializer(result)
        )
        return SerializedMcpToolResult(serialized, serialized)

    parts = [part for item in raw_content if (part := _content_block(item))]
    text = "\n".join(
        str(part.get("text") or "") for part in parts if part.get("type") == "text"
    ).strip()
    is_error = bool(envelope.get("isError") or envelope.get("is_error"))
    if is_error:
        serialized = (
            f"Error: {text}"
            if text
            else "MCP tool call failed: no extractable text in content blocks"
        )
        return SerializedMcpToolResult(serialized, serialized)

    media = [part for part in parts if part.get("type") in _MEDIA_TYPES]
    if not media:
        serialized = text or fallback_serializer(result)
        return SerializedMcpToolResult(serialized, serialized)

    display_text = text or "[visual media returned by tool]"
    durable_content = _encode_content([{"type": "text", "text": display_text}, *media])
    if media_offloader is not None:
        durable_content = (
            offload_multimodal_content(durable_content, media_offloader)
            or durable_content
        )
    return SerializedMcpToolResult(display_text, durable_content, len(media))
