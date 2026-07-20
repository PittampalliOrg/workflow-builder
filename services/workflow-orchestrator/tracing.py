from __future__ import annotations

import json
import logging
import os
from urllib.parse import quote
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

_TRACING_INITIALIZED = False
SESSION_ID_ATTRIBUTE = "session.id"
WORKFLOW_EXECUTION_ATTRIBUTE = "workflow.execution.id"
WORKFLOW_ACTIVITY_ATTRIBUTE = "workflow.activity.correlation_id"

WORKFLOW_ACTIVITY_BAGGAGE_KEYS = (
    WORKFLOW_ACTIVITY_ATTRIBUTE,
    "workflow.node.id",
    "workflow.node.name",
    "workflow.node.sequence",
    "workflow.node.action_type",
    WORKFLOW_EXECUTION_ATTRIBUTE,
    "workflow.id",
    SESSION_ID_ATTRIBUTE,
)
_BAGGAGE_VALUE_SAFE_CHARS = "!#$%&'()*+-./:<=>?@[]^_`{|}~"


def _parse_headers(value: str | None) -> dict[str, str] | None:
    if not value:
        return None
    out: dict[str, str] = {}
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k = k.strip()
        v = v.strip()
        if k:
            out[k] = v
    return out or None


def _parse_baggage_header(value: str | None) -> dict[str, str]:
    if not value:
        return {}
    out: dict[str, str] = {}
    for part in value.split(","):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        key = k.strip()
        value_part = v.strip()
        if key:
            out[key] = value_part
    return out


def _format_baggage_header(values: dict[str, Any]) -> str:
    parts: list[str] = []
    for key, raw_value in values.items():
        if not key or raw_value is None:
            continue
        value = str(raw_value).strip()
        if not value:
            continue
        parts.append(f"{key}={quote(value, safe=_BAGGAGE_VALUE_SAFE_CHARS)}")
    return ",".join(parts)


def workflow_activity_attrs_from_carrier(
    carrier: dict[str, Any] | None,
) -> dict[str, Any]:
    """Extract canonical workflow activity attributes from a W3C carrier."""
    if not isinstance(carrier, dict):
        return {}
    baggage = carrier.get("baggage")
    baggage_map = _parse_baggage_header(baggage if isinstance(baggage, str) else None)
    attrs: dict[str, Any] = {}
    for key in WORKFLOW_ACTIVITY_BAGGAGE_KEYS:
        value = carrier.get(key)
        if value is None:
            value = baggage_map.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            attrs[key] = text
    return attrs


def merge_workflow_activity_context(
    carrier: dict[str, Any] | None,
    attributes: dict[str, Any] | None,
) -> dict[str, str]:
    """Return an OTel carrier with semantic workflow activity baggage merged in.

    This deliberately preserves the engine-owned trace fields. Dapr task IDs are
    correlated from durabletask spans after the fact; the propagated carrier only
    holds semantic workflow/node identity.
    """
    base = carrier if isinstance(carrier, dict) else {}
    out: dict[str, str] = {}
    for key in ("traceparent", "tracestate", "traceId", "trace_id", "parentTraceId"):
        value = base.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()

    merged_baggage = _parse_baggage_header(
        base.get("baggage") if isinstance(base.get("baggage"), str) else None
    )
    for key in WORKFLOW_ACTIVITY_BAGGAGE_KEYS:
        value = base.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()
            if key not in merged_baggage:
                merged_baggage[key] = value.strip()
    for key, raw_value in (attributes or {}).items():
        if key not in WORKFLOW_ACTIVITY_BAGGAGE_KEYS:
            continue
        if raw_value is None:
            continue
        value = str(raw_value).strip()
        if value:
            merged_baggage[key] = value
            out[key] = value
    baggage_header = _format_baggage_header(merged_baggage)
    if baggage_header:
        out["baggage"] = baggage_header
    return out


def _otlp_endpoint_for(signal: str) -> str:
    base = (os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip().rstrip("/")
    if not base:
        return ""
    if base.endswith(f"/v1/{signal}"):
        return base
    return f"{base}/v1/{signal}"


def _env_bool(name: str, default: bool = False) -> bool:
    raw = (os.getenv(name) or "").strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "y", "on"}:
        return True
    if raw in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _env_is_none(name: str) -> bool:
    return (os.getenv(name) or "").strip().lower() in {"none", "off", "false", "0"}


def _otel_sdk_disabled() -> bool:
    return _env_bool("OTEL_SDK_DISABLED", False)


def _otel_signal_export_enabled(signal: str) -> bool:
    env_name = f"OTEL_{signal.upper()}_EXPORTER"
    return not _env_is_none(env_name)


def _parse_resource_attributes(value: str | None) -> dict[str, str]:
    # OTEL_RESOURCE_ATTRIBUTES uses comma-separated key=value.
    if not value:
        return {}
    out: dict[str, str] = {}
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k = k.strip()
        v = v.strip()
        if k:
            out[k] = v
    return out


def _clean_hex_id(value: object, length: int) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower().removeprefix("tr-").replace("-", "")
    if len(normalized) != length:
        return None
    if not all(c in "0123456789abcdef" for c in normalized):
        return None
    if int(normalized, 16) == 0:
        return None
    return normalized


def extract_otel_trace_id(carrier: dict[str, Any] | None) -> str | None:
    """Extract a valid 32-hex trace ID from a lightweight OTel carrier."""
    if not isinstance(carrier, dict):
        return None
    explicit = _clean_hex_id(carrier.get("traceId") or carrier.get("trace_id"), 32)
    if explicit:
        return explicit
    traceparent = carrier.get("traceparent")
    if isinstance(traceparent, str):
        parts = traceparent.strip().split("-")
        if len(parts) >= 4:
            return _clean_hex_id(parts[1], 32)
    return None


class JsonTraceFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }

        trace_id = getattr(record, "trace_id", None)
        span_id = getattr(record, "span_id", None)
        if trace_id:
            payload["trace_id"] = trace_id
        if span_id:
            payload["span_id"] = span_id

        # Preserve any structured context attached via logger extra=...
        extra = getattr(record, "extra", None)
        if isinstance(extra, dict):
            payload.update(extra)

        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)

        return json.dumps(payload, ensure_ascii=True)


class TraceContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            from opentelemetry import trace as ot_trace
            from opentelemetry import baggage as ot_baggage

            span = ot_trace.get_current_span()
            if span:
                ctx = span.get_span_context()
                if ctx and ctx.trace_id:
                    record.trace_id = f"{ctx.trace_id:032x}"
                    record.span_id = f"{ctx.span_id:016x}"
            session_id = workflow_session_id(
                ot_baggage.get_baggage(SESSION_ID_ATTRIBUTE)
                or ot_baggage.get_baggage("sessionId")
                or ot_baggage.get_baggage("session_id")
                or ot_baggage.get_baggage(WORKFLOW_EXECUTION_ATTRIBUTE)
            )
            if session_id:
                record.__dict__[SESSION_ID_ATTRIBUTE] = session_id
                record.__dict__[WORKFLOW_EXECUTION_ATTRIBUTE] = session_id
        except Exception:
            pass
        return True


def setup_logging_json(otel_handler: logging.Handler | None = None) -> None:
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)

    handler = logging.StreamHandler()
    handler.setFormatter(JsonTraceFormatter())
    handler.addFilter(TraceContextFilter())
    root.addHandler(handler)
    if otel_handler is not None:
        otel_handler.addFilter(TraceContextFilter())
        root.addHandler(otel_handler)


def setup_tracing(service_name: str, app: Any | None = None) -> bool:
    """
    Initialize OpenTelemetry (traces + metrics) and enable log/trace correlation.

    This is opt-in: if OTEL_EXPORTER_OTLP_ENDPOINT is not set, we do not start.
    """
    global _TRACING_INITIALIZED
    if _TRACING_INITIALIZED:
        return True

    if _otel_sdk_disabled():
        setup_logging_json()
        logger.info("[Tracing] OTEL_SDK_DISABLED=true; tracing disabled")
        _TRACING_INITIALIZED = True
        return False

    endpoint = (os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()
    if not endpoint:
        logger.info("[Tracing] OTEL_EXPORTER_OTLP_ENDPOINT not set; tracing disabled")
        _TRACING_INITIALIZED = True
        return False

    traces_enabled = _otel_signal_export_enabled("traces")
    metrics_enabled = _otel_signal_export_enabled("metrics")
    logs_enabled = _otel_signal_export_enabled("logs")
    if not (traces_enabled or metrics_enabled or logs_enabled):
        setup_logging_json()
        logger.info("[Tracing] all OTEL signal exporters disabled; tracing disabled")
        _TRACING_INITIALIZED = True
        return False

    try:
        from opentelemetry import metrics, trace
        from opentelemetry import _logs as ot_logs
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
            OTLPMetricExporter,
        )
        from opentelemetry.exporter.otlp.proto.http._log_exporter import (
            OTLPLogExporter,
        )
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        from opentelemetry.instrumentation.logging import LoggingInstrumentor
        from opentelemetry.instrumentation.requests import RequestsInstrumentor
        from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
        from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except Exception as e:
        logger.warning(f"[Tracing] Failed to import OpenTelemetry packages: {e}")
        _TRACING_INITIALIZED = True
        return False

    headers = _parse_headers(os.getenv("OTEL_EXPORTER_OTLP_HEADERS"))

    resource_attrs = _parse_resource_attributes(os.getenv("OTEL_RESOURCE_ATTRIBUTES"))
    resource_attrs.setdefault("service.name", os.getenv("OTEL_SERVICE_NAME") or service_name)

    resource = Resource.create(resource_attrs)

    if traces_enabled:
        tracer_provider = TracerProvider(resource=resource)
        tracer_provider.add_span_processor(
            BatchSpanProcessor(
                OTLPSpanExporter(
                    endpoint=_otlp_endpoint_for("traces"),
                    headers=headers,
                )
            )
        )
        trace.set_tracer_provider(tracer_provider)

    if metrics_enabled:
        metric_reader = PeriodicExportingMetricReader(
            OTLPMetricExporter(
                endpoint=_otlp_endpoint_for("metrics"),
                headers=headers,
            )
        )
        meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
        metrics.set_meter_provider(meter_provider)

    otel_handler: logging.Handler | None = None
    if logs_enabled:
        logger_provider = LoggerProvider(resource=resource)
        logger_provider.add_log_record_processor(
            BatchLogRecordProcessor(
                OTLPLogExporter(
                    endpoint=_otlp_endpoint_for("logs"),
                    headers=headers,
                )
            )
        )
        ot_logs.set_logger_provider(logger_provider)
        otel_handler = LoggingHandler(
            level=logging.NOTSET,
            logger_provider=logger_provider,
        )

    # Auto instrumentation for inbound/outbound HTTP.
    if traces_enabled:
        RequestsInstrumentor().instrument()
        HTTPXClientInstrumentor().instrument()
        LoggingInstrumentor().instrument(set_logging_format=False)
        if app is not None:
            try:
                FastAPIInstrumentor.instrument_app(app)
            except Exception as e:
                logger.debug(f"[Tracing] FastAPI instrumentation failed: {e}")

    setup_logging_json(otel_handler)

    _TRACING_INITIALIZED = True
    logger.info(
        "[Tracing] OpenTelemetry enabled (OTLP HTTP; traces=%s metrics=%s logs=%s)",
        traces_enabled,
        metrics_enabled,
        logs_enabled,
    )
    return True


def inject_current_context() -> dict[str, str]:
    """
    Serialize the current trace context into a simple carrier dict.
    """
    try:
        from opentelemetry.propagate import inject

        carrier: dict[str, str] = {}
        inject(carrier)
        # We only care about w3c headers today.
        filtered = {
            k: v
            for k, v in carrier.items()
            if k in ("traceparent", "tracestate", "baggage")
        }
        if filtered.get("traceparent"):
            return filtered

        from opentelemetry import trace as ot_trace

        span = ot_trace.get_current_span()
        ctx = span.get_span_context() if span else None
        if ctx and ctx.is_valid:
            filtered["traceparent"] = (
                f"00-{ctx.trace_id:032x}-{ctx.span_id:016x}-01"
            )
        return filtered
    except Exception:
        return {}


def workflow_session_id(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def extract_session_id(carrier: dict[str, Any] | None) -> str | None:
    if not isinstance(carrier, dict):
        return None
    explicit = workflow_session_id(
        carrier.get("sessionId")
        or carrier.get("session_id")
        or carrier.get(SESSION_ID_ATTRIBUTE)
        or carrier.get("x-workflow-session-id")
    )
    if explicit:
        return explicit
    baggage = carrier.get("baggage")
    if isinstance(baggage, str):
        baggage_map = _parse_baggage_header(baggage)
        return workflow_session_id(
            baggage_map.get(SESSION_ID_ATTRIBUTE)
            or baggage_map.get(WORKFLOW_EXECUTION_ATTRIBUTE)
        )
    return None


def attach_workflow_session(span: Any, session_id: str | None) -> None:
    if not span or not session_id:
        return
    try:
        span.set_attribute(SESSION_ID_ATTRIBUTE, session_id)
        span.set_attribute(WORKFLOW_EXECUTION_ATTRIBUTE, session_id)
    except Exception:
        pass



def _extract_context(carrier: dict[str, str] | None):
    try:
        from opentelemetry.propagate import extract

        return extract(carrier or {})
    except Exception:
        return None


@contextmanager
def start_activity_span(
    name: str,
    carrier: dict[str, str] | None,
    attributes: dict[str, Any] | None = None,
):
    try:
        from opentelemetry import trace as ot_trace

        tracer = ot_trace.get_tracer("workflow-orchestrator")
        parent_ctx = _extract_context(carrier)
    except Exception:
        # Fallback mode: run without tracing context.
        yield None
        return

    with tracer.start_as_current_span(name, context=parent_ctx) as span:
        attach_workflow_session(span, extract_session_id(carrier))
        if attributes:
            for k, v in attributes.items():
                if v is None:
                    continue
                try:
                    span.set_attribute(k, v)
                except Exception:
                    pass
        yield span


def apply_workflow_activity_context(
    carrier: dict[str, Any] | None,
    attributes: dict[str, Any] | None = None,
) -> dict[str, str]:
    """Stamp workflow activity attrs on the active span and return merged carrier."""
    merged = merge_workflow_activity_context(carrier, attributes)
    span_attrs = workflow_activity_attrs_from_carrier(merged)
    if attributes:
        span_attrs.update(
            {
                key: value
                for key, value in attributes.items()
                if key in WORKFLOW_ACTIVITY_BAGGAGE_KEYS and value is not None
            }
        )
    set_current_span_attrs(span_attrs)
    return merged


def set_current_span_attrs(attributes: dict[str, Any] | None) -> None:
    """Stamp attributes onto the **currently active** OTel span.

    Used by Dapr activity bodies to enrich the outer
    `activity||<name>` span the durabletask runtime creates around them.
    Best-effort: no active span / no OTel install → silent no-op.
    None / empty-string / empty-list values are skipped automatically.

    Convenience over calling `trace.get_current_span().set_attribute()`
    directly: defends against the no-op `INVALID_SPAN` sentinel + handles
    list/tuple/None coercion in one place.
    """
    if not attributes:
        return
    try:
        from opentelemetry import trace as ot_trace
    except Exception:
        return
    try:
        span = ot_trace.get_current_span()
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
    for k, v in attributes.items():
        if v is None:
            continue
        if isinstance(v, str) and not v:
            continue
        if isinstance(v, (list, tuple)) and not v:
            continue
        try:
            span.set_attribute(str(k), v)
        except Exception:
            pass
