"""OpenTelemetry tracing helpers for dapr-swe agent activities."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Generator, Mapping


def _get_tracer():
    """Get the dapr-swe tracer (lazy import to handle missing OTEL gracefully)."""
    try:
        from opentelemetry import trace
        return trace.get_tracer("dapr-swe")
    except Exception:
        return None


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
