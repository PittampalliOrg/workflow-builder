"""Redact secrets and inline media before content enters OpenTelemetry."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit


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
_SENSITIVE_QUERY_KEY_EXACT = {
    "accesstoken",
    "apikey",
    "authtoken",
    "authorization",
    "awsaccesskeyid",
    "bearer",
    "credential",
    "googleaccessid",
    "idtoken",
    "key",
    "password",
    "policy",
    "refreshtoken",
    "secret",
    "securitytoken",
    "sig",
    "signature",
    "token",
}
_SENSITIVE_MAPPING_KEY_EXACT = _SENSITIVE_QUERY_KEY_EXACT - {"key", "policy"}
_BEARER_RE = re.compile(
    r"(?P<prefix>\bBearer\s+)(?P<value>[a-z0-9._~+/=-]+)", re.IGNORECASE
)
_URL_RE = re.compile(r"\bhttps?://[^\s<>'\"\\]+", re.IGNORECASE)
_QUERY_SECRET_RE = re.compile(
    r"(?P<prefix>\b(?:access[_-]?token|auth[_-]?token|refresh[_-]?token|"
    r"id[_-]?token|api[_-]?key|authorization|x-amz-signature|"
    r"x-amz-credential|x-amz-security-token|x-goog-signature|"
    r"x-goog-credential|x-goog-security-token|signature|credential|sig)\s*=\s*)"
    r"(?P<value>[^&\s,;\"'<>]+)",
    re.IGNORECASE,
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
_MEDIA_CONTAINER_FAMILY = {
    "audio": "audio",
    "image": "image",
    "image_url": "image",
    "input_audio": "audio",
    "input_image": "image",
    "input_video": "video",
    "video": "video",
    "video_url": "video",
}
_FORMAT_MEDIA_TYPES = {
    "aac": "audio/aac",
    "flac": "audio/flac",
    "gif": "image/gif",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "mp3": "audio/mpeg",
    "mp4": "video/mp4",
    "mpeg": "audio/mpeg",
    "ogg": "audio/ogg",
    "png": "image/png",
    "wav": "audio/wav",
    "webm": "video/webm",
    "webp": "image/webp",
}
_SCHEMA_CONTAINER_KEYS = {
    "inputschema",
    "jsonschema",
    "outputschema",
    "parameters",
    "schema",
}
_SCHEMA_DESCRIPTOR_KEYS = {
    "additionalproperties",
    "allof",
    "anchor",
    "anyof",
    "comment",
    "const",
    "contains",
    "contentencoding",
    "contentmediatype",
    "contentschema",
    "default",
    "definitions",
    "defs",
    "dependentrequired",
    "dependentschemas",
    "deprecated",
    "description",
    "discriminator",
    "dynamicanchor",
    "dynamicref",
    "else",
    "enum",
    "example",
    "examples",
    "exclusivemaximum",
    "exclusiveminimum",
    "format",
    "id",
    "if",
    "items",
    "maxlength",
    "maxcontains",
    "maxitems",
    "maximum",
    "maxproperties",
    "mincontains",
    "minitems",
    "minlength",
    "minimum",
    "minproperties",
    "multipleof",
    "not",
    "nullable",
    "oneof",
    "pattern",
    "patternproperties",
    "prefixitems",
    "properties",
    "propertynames",
    "readonly",
    "ref",
    "required",
    "schema",
    "then",
    "title",
    "type",
    "unevaluateditems",
    "unevaluatedproperties",
    "uniqueitems",
    "vocabulary",
    "writeonly",
}
_SCHEMA_SECRET_VALUE_KEYS = {"const", "default", "enum", "example", "examples"}


def _media_placeholder(media_type: str, payload: str, transport: str) -> str:
    digest = hashlib.sha256(payload.encode("ascii", errors="ignore")).hexdigest()[:16]
    return (
        "[REDACTED_INLINE_MEDIA "
        f"mime={media_type.lower()} transport={transport} "
        f"encoded_chars={len(payload)} sha256={digest}]"
    )


def _binary_placeholder(value: bytes | bytearray) -> str:
    payload = bytes(value)
    digest = hashlib.sha256(payload).hexdigest()[:16]
    return f"[REDACTED_BINARY bytes={len(payload)} sha256={digest}]"


def _replace_data_media_uris(value: str) -> str:
    return _DATA_MEDIA_URI_RE.sub(
        lambda match: _media_placeholder(
            match.group("mime"), match.group("payload"), "data_uri"
        ),
        value,
    )


def _normalized_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _is_sensitive_mapping_key(key: str) -> bool:
    key_norm = key.replace("-", "_").lower()
    compact = _normalized_key(key)
    return (
        key_norm in _SENSITIVE_KEY_EXACT
        or key_norm.endswith("_token")
        or compact in _SENSITIVE_MAPPING_KEY_EXACT
        or compact.endswith(
            ("apikey", "credential", "password", "secret", "signature", "token")
        )
        or _SENSITIVE_KEY_RE.search(key) is not None
        or any(part in key_norm for part in _SENSITIVE_KEY_PARTS)
    )


def _is_sensitive_query_key(key: str) -> bool:
    compact = _normalized_key(key)
    return compact in _SENSITIVE_QUERY_KEY_EXACT or compact.endswith(
        ("apikey", "credential", "password", "secret", "signature", "token")
    )


def _redact_url_query(match: re.Match[str]) -> str:
    raw_url = match.group(0)
    trailing = ""
    while raw_url and raw_url[-1] in ".,);]":
        trailing = raw_url[-1] + trailing
        raw_url = raw_url[:-1]
    try:
        parsed = urlsplit(raw_url)
        pairs = parse_qsl(parsed.query, keep_blank_values=True)
    except ValueError:
        safe_url = re.sub(
            r"(?<=://)[^/@\s]+@",
            f"{quote(_REDACTED, safe='')}@",
            raw_url,
            count=1,
        )
        return safe_url + trailing
    has_userinfo = "@" in parsed.netloc
    changed = has_userinfo
    safe_netloc = parsed.netloc
    if has_userinfo:
        host_and_port = parsed.netloc.rsplit("@", 1)[-1]
        safe_netloc = f"{quote(_REDACTED, safe='')}@{host_and_port}"
    safe_pairs: list[tuple[str, str]] = []
    for key, value in pairs:
        if _is_sensitive_query_key(key):
            value = _REDACTED
            changed = True
        safe_pairs.append((key, value))
    if not changed:
        return match.group(0)
    safe_url = urlunsplit(
        (
            parsed.scheme,
            safe_netloc,
            parsed.path,
            urlencode(safe_pairs, doseq=True),
            parsed.fragment,
        )
    )
    return safe_url + trailing


def _replace_inline_credentials(value: str) -> str:
    value = _BEARER_RE.sub(lambda match: f"{match.group('prefix')}{_REDACTED}", value)
    value = _QUERY_SECRET_RE.sub(
        lambda match: f"{match.group('prefix')}{_REDACTED}", value
    )
    return _URL_RE.sub(_redact_url_query, value)


def _mapping_media_type(value: dict[str, Any]) -> str | None:
    for key in ("mimeType", "mediaType", "media_type", "contentType"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate.lower().startswith(
            ("image/", "video/", "audio/")
        ):
            return candidate.lower()
    media_format = value.get("format")
    if isinstance(media_format, str):
        return _FORMAT_MEDIA_TYPES.get(media_format.strip().lower())
    return None


def _mapping_media_family(value: dict[str, Any]) -> str | None:
    media_type = _mapping_media_type(value)
    if media_type:
        return media_type.split("/", 1)[0]
    block_type = str(value.get("type") or "").strip().lower()
    if "audio" in block_type:
        return "audio"
    if "image" in block_type:
        return "image"
    if "video" in block_type:
        return "video"
    return None


def _is_schema_descriptor(value: Any) -> bool:
    if isinstance(value, bool):
        return True
    if not isinstance(value, dict):
        return False
    if not value:
        return True
    return any(_normalized_key(str(key)) in _SCHEMA_DESCRIPTOR_KEYS for key in value)


def _is_json_schema_mapping(value: dict[str, Any], *, hinted: bool) -> bool:
    """Recognize a schema before exempting its property descriptor names."""
    properties = value.get("properties")
    if not isinstance(properties, dict) or not all(
        _is_schema_descriptor(descriptor) for descriptor in properties.values()
    ):
        return False
    schema_type = value.get("type")
    object_typed = schema_type == "object" or (
        isinstance(schema_type, (list, tuple)) and "object" in schema_type
    )
    return object_typed or "$schema" in value or hinted


def _redact_schema_value(value: Any) -> Any:
    if isinstance(value, (list, tuple)):
        return [_REDACTED for _ in value]
    return _REDACTED


def sanitize_text_for_telemetry(value: str, *, depth: int = 0) -> str:
    """Redact credentials and inline media, including inside JSON strings."""
    if depth > _MAX_REDACT_DEPTH:
        return "[redaction-depth-exceeded]"
    try:
        replaced = _replace_inline_credentials(_replace_data_media_uris(value))
    except Exception:  # noqa: BLE001
        return "[TELEMETRY_SANITIZATION_FAILED]"
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


def sanitize_content_for_telemetry(
    value: Any,
    *,
    depth: int = 0,
    _media_family: str | None = None,
    _schema_property_map: bool = False,
    _schema_context: bool = False,
    _sensitive_schema_property: bool = False,
) -> Any:
    """Return an observability-safe copy without changing durable/provider data."""
    if depth > _MAX_REDACT_DEPTH:
        return "[redaction-depth-exceeded]"
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        block_type = str(value.get("type") or "").strip().lower()
        media_family = _media_family or _mapping_media_family(value)
        media_mapping = (
            media_family is not None
            or block_type in _MEDIA_BLOCK_TYPES
            or _mapping_media_type(value) is not None
        )
        media_type = _mapping_media_type(value) or (
            f"{media_family}/unknown" if media_family else "application/octet-stream"
        )
        schema_mapping = _is_json_schema_mapping(value, hinted=_schema_context)
        for key, item in value.items():
            key_text = str(key)
            key_norm = key_text.replace("-", "_").lower()
            compact_key = _normalized_key(key_text)
            if _sensitive_schema_property and compact_key in _SCHEMA_SECRET_VALUE_KEYS:
                redacted[key_text] = _redact_schema_value(item)
            elif (
                _sensitive_schema_property
                and compact_key not in _SCHEMA_DESCRIPTOR_KEYS
            ):
                redacted[key_text] = _REDACTED
            elif not _schema_property_map and _is_sensitive_mapping_key(key_text):
                redacted[key_text] = _REDACTED
            elif (
                media_mapping and key_norm == "data" and isinstance(item, str) and item
            ):
                redacted[key_text] = _media_placeholder(
                    media_type, item, "base64_field"
                )
            else:
                nested_family = _MEDIA_CONTAINER_FAMILY.get(key_norm)
                if key_norm == "source":
                    nested_family = media_family
                child_is_schema_property_map = (
                    compact_key == "properties" and schema_mapping
                )
                redacted[key_text] = sanitize_content_for_telemetry(
                    item,
                    depth=depth + 1,
                    _media_family=nested_family,
                    _schema_property_map=child_is_schema_property_map,
                    _schema_context=(
                        _schema_property_map
                        or compact_key in _SCHEMA_CONTAINER_KEYS
                        or child_is_schema_property_map
                    ),
                    _sensitive_schema_property=(
                        _schema_property_map and _is_sensitive_mapping_key(key_text)
                    ),
                )
        return redacted
    if isinstance(value, (list, tuple)):
        return [
            sanitize_content_for_telemetry(
                item,
                depth=depth + 1,
                _media_family=_media_family,
                _schema_property_map=_schema_property_map,
                _schema_context=_schema_context,
                _sensitive_schema_property=_sensitive_schema_property,
            )
            for item in value
        ]
    if isinstance(value, str):
        return sanitize_text_for_telemetry(value, depth=depth + 1)
    if isinstance(value, (bytes, bytearray)):
        return _binary_placeholder(value)
    return value


__all__ = ["sanitize_content_for_telemetry", "sanitize_text_for_telemetry"]
