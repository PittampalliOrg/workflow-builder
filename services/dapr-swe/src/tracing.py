"""OpenTelemetry tracing helpers for dapr-swe agent activities."""

from __future__ import annotations

import json
import os
import re
from contextlib import contextmanager
from typing import Any, Generator, Mapping

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


def _get_tracer():
    """Get the dapr-swe tracer (lazy import to handle missing OTEL gracefully)."""
    try:
        from opentelemetry import trace
        return trace.get_tracer("dapr-swe")
    except Exception:
        return None


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
    """Stamp ``<prefix>.value`` (+ mime/truncation, redacted) on ``span``."""
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
    set_span_io(span, prefix, obj)


@contextmanager
def trace_activity(name: str, attributes: dict[str, Any] | None = None) -> Generator:
    """Create a traced span for a workflow activity.

    Usage:
        with trace_activity("dapr-swe.plan", {"repo": "planner-agent"}):
            result = run_planner(...)
    """
    tracer = _get_tracer()
    if tracer is None:
        yield
        return

    with tracer.start_as_current_span(name, attributes=attributes or {}) as span:
        try:
            yield span
        except Exception as exc:
            span.set_attribute("error", True)
            span.set_attribute("error.message", str(exc))
            raise


@contextmanager
def trace_activity_with_parent(
    name: str,
    attributes: dict[str, Any] | None = None,
    headers: Mapping[str, str] | None = None,
) -> Generator:
    """Create a traced span that is a child of the incoming W3C trace context.

    Extracts traceparent/tracestate from *headers* so that spans created by
    dapr-swe appear as children of the orchestrator trace rather than
    starting a new root trace.

    Usage:
        hdrs = {"traceparent": request.headers.get("traceparent")}
        with trace_activity_with_parent("dapr-swe.plan", headers=hdrs):
            result = run_planner(...)
    """
    tracer = _get_tracer()
    if tracer is None:
        yield
        return

    # Restore parent context from incoming HTTP headers (if any).
    token = None
    try:
        if headers:
            from opentelemetry import context as otel_context
            from opentelemetry.propagate import extract

            parent_ctx = extract(headers)
            token = otel_context.attach(parent_ctx)
    except Exception:
        pass  # Fall back to root span if extraction fails

    try:
        with tracer.start_as_current_span(name, attributes=attributes or {}) as span:
            try:
                yield span
            except Exception as exc:
                span.set_attribute("error", True)
                span.set_attribute("error.message", str(exc))
                raise
    finally:
        if token is not None:
            try:
                from opentelemetry import context as otel_context
                otel_context.detach(token)
            except Exception:
                pass
