"""Request/response content capture for sandbox-execution-api spans.

Emits OpenInference ``input.value`` / ``output.value`` attributes, the
convention rendered by the Service Graph drill-down drawer. Values are
deep-redacted, JSON serialized, and capped before being written to spans.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
from typing import Any, Iterator

DEFAULT_MAX_BYTES = 60_000
_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"0", "false", "no", "off"}
_REDACTED = "[REDACTED]"
_MAX_REDACT_DEPTH = 12

_REDACT_KEY_RE = re.compile(
    r"(token|secret|password|passwd|api[_-]?key|authorization|auth|credential|"
    r"bearer|private[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|"
    r"session[_-]?token|cookie|x-api-key)",
    re.IGNORECASE,
)


def content_tracing_enabled() -> bool:
    if (os.environ.get("ENABLE_BETA_TRACING_DETAILED") or "").strip().lower() in _TRUTHY:
        return True
    return (os.environ.get("ENABLE_REQUEST_CONTENT_TRACING") or "").strip().lower() not in _FALSY


def redact(obj: Any, _depth: int = 0) -> Any:
    if _depth > _MAX_REDACT_DEPTH:
        return "[redaction-depth-exceeded]"
    if isinstance(obj, dict):
        out: dict[Any, Any] = {}
        for k, v in obj.items():
            out[k] = _REDACTED if isinstance(k, str) and _REDACT_KEY_RE.search(k) else redact(v, _depth + 1)
        return out
    if isinstance(obj, (list, tuple)):
        return [redact(v, _depth + 1) for v in obj]
    return obj


def _serialize(obj: Any) -> str:
    if isinstance(obj, str):
        return obj
    try:
        return json.dumps(obj, default=str, ensure_ascii=False)
    except Exception:
        return str(obj)


def set_span_io(span: Any, prefix: str, obj: Any, *, max_bytes: int = DEFAULT_MAX_BYTES) -> None:
    if span is None or obj is None or not content_tracing_enabled():
        return
    try:
        serialized = _serialize(redact(obj))
        if not serialized:
            return
        encoded = serialized.encode("utf-8")
        truncated = len(encoded) > max_bytes
        value = encoded[:max_bytes].decode("utf-8", errors="ignore") if truncated else serialized
        span.set_attribute(f"{prefix}.value", value)
        span.set_attribute(f"{prefix}.mime_type", "application/json")
        if truncated:
            span.set_attribute(f"{prefix}.value_truncated", True)
            span.set_attribute(f"{prefix}.value_original_length", len(encoded))
    except Exception:
        pass


def set_current_span_io(prefix: str, obj: Any) -> None:
    try:
        from opentelemetry import trace as _t

        span = _t.get_current_span()
    except Exception:
        return
    if span is None:
        return
    try:
        sc = span.get_span_context()
        if sc is None or getattr(sc, "trace_id", 0) == 0:
            return
    except Exception:
        return
    set_span_io(span, prefix, obj)


@contextlib.contextmanager
def content_span(name: str) -> Iterator[Any]:
    if not content_tracing_enabled():
        yield None
        return
    try:
        from opentelemetry import trace as _t

        tracer = _t.get_tracer("sandbox-execution-api")
    except Exception:
        yield None
        return
    with tracer.start_as_current_span(name) as span:
        yield span
