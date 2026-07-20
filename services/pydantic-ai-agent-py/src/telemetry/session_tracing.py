"""Trace-context handle for session events.

The vendored ``event_publisher`` lazily imports
``src.telemetry.session_tracing.get_current_trace_context`` to stamp
``traceId``/``spanId`` onto every session-event envelope — the UI uses them to
deep-link an event row into the ClickHouse trace view. Unlike dapr-agent-py
(which parks spans in ContextVars), this runtime always opens spans with
``start_as_current_span``, so the OTel current-span lookup is sufficient.
"""

from __future__ import annotations


def get_current_trace_context() -> tuple[str | None, str | None]:
    """Return (trace_id_hex, span_id_hex) of the active span, or (None, None)."""
    try:
        from opentelemetry import trace as otel_trace

        span = otel_trace.get_current_span()
        if span is None:
            return None, None
        ctx = span.get_span_context()
        if not ctx.is_valid:
            return None, None
        return format(ctx.trace_id, "032x"), format(ctx.span_id, "016x")
    except Exception:  # noqa: BLE001
        return None, None
