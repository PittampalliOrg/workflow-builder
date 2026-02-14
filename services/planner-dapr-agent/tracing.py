from __future__ import annotations

import json
import logging
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

_TRACING_INITIALIZED = False


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


def _otlp_endpoint_for(signal: str) -> str:
    base = (os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip().rstrip("/")
    if not base:
        return ""
    if base.endswith(f"/v1/{signal}"):
        return base
    return f"{base}/v1/{signal}"


def _parse_resource_attributes(value: str | None) -> dict[str, str]:
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

        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)

        return json.dumps(payload, ensure_ascii=True)


class TraceContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            from opentelemetry import trace as ot_trace

            span = ot_trace.get_current_span()
            if span:
                ctx = span.get_span_context()
                if ctx and ctx.trace_id:
                    record.trace_id = f"{ctx.trace_id:032x}"
                    record.span_id = f"{ctx.span_id:016x}"
        except Exception:
            pass
        return True


def setup_logging_json() -> None:
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)

    handler = logging.StreamHandler()
    handler.setFormatter(JsonTraceFormatter())
    handler.addFilter(TraceContextFilter())
    root.addHandler(handler)


def setup_tracing(
    project_name: str | None = None,
    service_name: str | None = None,
    app: Any | None = None,
    enable_openai_instrumentation: bool = False,
    trace_include_sensitive_data: bool = False,
    **_: Any,
):
    """
    Initialize OpenTelemetry (traces + metrics) and enable log/trace correlation.

    Planner already has OpenInference deps installed; this optionally enables them.
    """
    global _TRACING_INITIALIZED
    if _TRACING_INITIALIZED:
        return True

    endpoint = (os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()
    if not endpoint:
        logger.info("[Tracing] OTEL_EXPORTER_OTLP_ENDPOINT not set; tracing disabled")
        _TRACING_INITIALIZED = True
        return False

    name = (os.getenv("OTEL_SERVICE_NAME") or service_name or project_name or "planner-dapr-agent").strip()

    try:
        from opentelemetry import metrics, trace
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        from opentelemetry.instrumentation.logging import LoggingInstrumentor
        from opentelemetry.instrumentation.requests import RequestsInstrumentor
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
    resource_attrs.setdefault("service.name", name)
    resource = Resource.create(resource_attrs)

    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(endpoint=_otlp_endpoint_for("traces"), headers=headers)
        )
    )
    trace.set_tracer_provider(tracer_provider)

    metric_reader = PeriodicExportingMetricReader(
        OTLPMetricExporter(endpoint=_otlp_endpoint_for("metrics"), headers=headers)
    )
    meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
    metrics.set_meter_provider(meter_provider)

    RequestsInstrumentor().instrument()
    HTTPXClientInstrumentor().instrument()
    LoggingInstrumentor().instrument(set_logging_format=False)
    if app is not None:
        try:
            FastAPIInstrumentor.instrument_app(app)
        except Exception as e:
            logger.debug(f"[Tracing] FastAPI instrumentation failed: {e}")

    if enable_openai_instrumentation:
        try:
            from openinference.instrumentation.openai import OpenAIInstrumentor

            OpenAIInstrumentor().instrument(
                trace_include_sensitive_data=trace_include_sensitive_data
            )
            logger.info("[Tracing] OpenInference OpenAI instrumentation enabled")
        except Exception as e:
            logger.debug(f"[Tracing] OpenInference OpenAI instrumentation not enabled: {e}")

    setup_logging_json()
    _TRACING_INITIALIZED = True
    logger.info("[Tracing] OpenTelemetry enabled (OTLP HTTP)")
    return True


def inject_current_context() -> dict[str, str]:
    try:
        from opentelemetry.propagate import inject

        carrier: dict[str, str] = {}
        inject(carrier)
        return {k: v for k, v in carrier.items() if k in ("traceparent", "tracestate")}
    except Exception:
        return {}


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

        tracer = ot_trace.get_tracer("planner-dapr-agent")
        parent_ctx = _extract_context(carrier)
        with tracer.start_as_current_span(name, context=parent_ctx) as span:
            if attributes:
                for k, v in attributes.items():
                    if v is None:
                        continue
                    try:
                        span.set_attribute(k, v)
                    except Exception:
                        pass
            yield span
    except Exception:
        yield None

