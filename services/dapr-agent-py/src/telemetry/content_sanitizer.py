"""Redact secrets and inline media before content enters OpenTelemetry."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any


_REDACTED = "[REDACTED]"
_MAX_REDACT_DEPTH = 12
_SENSITIVE_KEY_PARTS = (
    "api_key",
    "apikey",
    "authorization",
    "bearer",
    "client_secret",
    "password",
    "secret",
)
_SENSITIVE_KEY_EXACT = {"access_token", "auth_token", "refresh_token", "token"}
_SENSITIVE_KEY_RE = re.compile(
    r"(x-api-key|private[_-]?key|session[_-]?token)", re.IGNORECASE
)
_DATA_MEDIA_URI_RE = re.compile(
    r"data:(?P<mime>(?:image|video|audio)/[a-z0-9.+-]+)"
    r"[^,\s]{0,256};base64,(?P<payload>[a-z0-9+/=_-]+)",
    re.IGNORECASE,
)
_MEDIA_BLOCK_TYPES = {
    "audio",
    "base64",
    "image",
    "image_url",
    "input_audio",
    "input_image",
    "input_video",
    "video",
    "video_url",
}


def _media_placeholder(media_type: str, payload: str, transport: str) -> str:
    digest = hashlib.sha256(payload.encode("ascii", errors="ignore")).hexdigest()[:16]
    return (
        "[REDACTED_INLINE_MEDIA "
        f"mime={media_type.lower()} transport={transport} "
        f"encoded_chars={len(payload)} sha256={digest}]"
    )


def _replace_data_media_uris(value: str) -> str:
    return _DATA_MEDIA_URI_RE.sub(
        lambda match: _media_placeholder(
            match.group("mime"), match.group("payload"), "data_uri"
        ),
        value,
    )


def _mapping_media_type(value: dict[str, Any]) -> str | None:
    for key in ("mimeType", "mediaType", "media_type", "contentType"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate.lower().startswith(
            ("image/", "video/", "audio/")
        ):
            return candidate.lower()
    return None


def _is_media_mapping(value: dict[str, Any]) -> bool:
    block_type = str(value.get("type") or "").strip().lower()
    return block_type in _MEDIA_BLOCK_TYPES or _mapping_media_type(value) is not None


def sanitize_text_for_telemetry(value: str, *, depth: int = 0) -> str:
    """Redact data-media URIs, including those nested in a JSON string."""
    replaced = _replace_data_media_uris(value)
    if depth > _MAX_REDACT_DEPTH:
        return "[redaction-depth-exceeded]"
    stripped = replaced.lstrip()
    if not stripped.startswith(("{", "[")):
        return replaced
    try:
        parsed = json.loads(replaced)
    except (TypeError, ValueError, json.JSONDecodeError):
        return replaced
    if not isinstance(parsed, (dict, list)):
        return replaced
    return json.dumps(
        sanitize_content_for_telemetry(parsed, depth=depth + 1),
        ensure_ascii=False,
        separators=(",", ":"),
    )


def sanitize_content_for_telemetry(value: Any, *, depth: int = 0) -> Any:
    """Return an observability-safe copy without changing durable/provider data."""
    if depth > _MAX_REDACT_DEPTH:
        return "[redaction-depth-exceeded]"
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        media_mapping = _is_media_mapping(value)
        media_type = _mapping_media_type(value) or "application/octet-stream"
        for key, item in value.items():
            key_text = str(key)
            key_norm = key_text.replace("-", "_").lower()
            if (
                key_norm in _SENSITIVE_KEY_EXACT
                or key_norm.endswith("_token")
                or _SENSITIVE_KEY_RE.search(key_text)
                or any(part in key_norm for part in _SENSITIVE_KEY_PARTS)
            ):
                redacted[key_text] = _REDACTED
            elif (
                media_mapping and key_norm == "data" and isinstance(item, str) and item
            ):
                redacted[key_text] = _media_placeholder(
                    media_type, item, "base64_field"
                )
            else:
                redacted[key_text] = sanitize_content_for_telemetry(
                    item, depth=depth + 1
                )
        return redacted
    if isinstance(value, (list, tuple)):
        return [sanitize_content_for_telemetry(item, depth=depth + 1) for item in value]
    if isinstance(value, str):
        return sanitize_text_for_telemetry(value, depth=depth + 1)
    return value


__all__ = ["sanitize_content_for_telemetry", "sanitize_text_for_telemetry"]
