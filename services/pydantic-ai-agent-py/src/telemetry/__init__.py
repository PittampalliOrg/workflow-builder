"""OpenTelemetry for pydantic-ai-agent-py — pydantic-ai-native first.

Strategy (see docs/pydantic-ai-observability.md):

- **LLM-call fidelity is pydantic-ai's own instrumentation**: the model is
  wrapped in ``InstrumentedModel`` (GenAI semconv, ``InstrumentationSettings``
  default version) which emits ``chat <model>`` CLIENT spans carrying
  ``gen_ai.request.*`` / ``gen_ai.response.*`` / usage / cost /
  ``gen_ai.input.messages`` + ``gen_ai.output.messages``, plus native
  ``gen_ai.client.token.usage`` metrics. It binds to the GLOBAL OTel
  providers configured here — plain OTLP to the cluster collector, no
  Logfire account or vendor coupling.
- **The Dapr connection**: each durable activity (``call_llm`` /
  ``execute_tool``) opens an activity span parented on the inbound
  ``WORKFLOW_BUILDER_TRACEPARENT`` (the BFF/orchestrator trace, stamped onto
  the pod by sandbox-execution-api via downward-API env), so agent spans join
  the same distributed trace as the daprd workflow/activity spans instead of
  shattering into per-activity orphan traces.
- **Platform contract**: the activity spans carry ``session.id`` /
  ``workflow.execution.id`` plus the OpenInference keys the curated
  ClickHouse views read (``obs.llm_spans`` / ``obs.tool_spans`` gate on
  ``openinference.span.kind`` and read ``llm.token_count.*`` /
  ``llm.{input,output}_messages`` / ``tool.*``). The native ``chat`` span
  nests inside the activity span; it has no ``openinference.span.kind`` so
  the curated views never double-count.

Everything is gated on ``OTEL_EXPORTER_OTLP_ENDPOINT`` — unset (local dev,
unit tests) means every helper is a no-op.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import threading
from contextlib import contextmanager
from typing import Any, Iterator

logger = logging.getLogger(__name__)

# OpenInference content attrs are capped like dapr-agent-py's beta tier so a
# huge prompt can't blow up the collector pipeline.
MAX_CONTENT_SIZE = 60_000

_TRACER_NAME = "pydantic-ai-agent-py"

_lock = threading.Lock()
_initialized = False
_enabled = False
_tracer: Any = None
_tracer_provider: Any = None
_meter_provider: Any = None
_logger_provider: Any = None
_inbound_context: Any = None
_instrumentation_settings: Any = None


def _endpoint() -> str:
    return (os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()


def telemetry_enabled() -> bool:
    return _enabled


def content_capture_enabled() -> bool:
    """Prompt/completion/tool content on spans; same knob dapr-agent-py uses."""
    return (os.environ.get("OTEL_LOG_USER_PROMPTS") or "true").strip().lower() not in (
        "false",
        "0",
        "no",
    )


def init_telemetry() -> bool:
    """Configure global OTel providers (traces + metrics + logs) once.

    Returns True when exporting is live. Safe to call repeatedly.
    """
    global _initialized, _enabled, _tracer, _tracer_provider
    global _meter_provider, _logger_provider, _instrumentation_settings

    with _lock:
        if _initialized:
            return _enabled
        _initialized = True

        endpoint = _endpoint()
        if not endpoint:
            logger.info("[otel] OTEL_EXPORTER_OTLP_ENDPOINT unset — telemetry disabled")
            return False

        try:
            from opentelemetry import metrics as otel_metrics
            from opentelemetry import trace as otel_trace
            from opentelemetry._logs import set_logger_provider
            from opentelemetry.exporter.otlp.proto.http._log_exporter import (
                OTLPLogExporter,
            )
            from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
                OTLPMetricExporter,
            )
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
                OTLPSpanExporter,
            )
            from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
            from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
            from opentelemetry.sdk.metrics import MeterProvider
            from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
            from opentelemetry.sdk.resources import Resource
            from opentelemetry.sdk.trace import TracerProvider
            from opentelemetry.sdk.trace.export import BatchSpanProcessor

            base = endpoint.rstrip("/")
            resource = Resource.create(
                {
                    "service.name": os.environ.get(
                        "OTEL_SERVICE_NAME", "pydantic-ai-agent-py"
                    ),
                    "service.namespace": os.environ.get(
                        "OTEL_SERVICE_NAMESPACE", "workflow-builder"
                    ),
                }
            )

            _tracer_provider = TracerProvider(resource=resource)
            _tracer_provider.add_span_processor(
                BatchSpanProcessor(
                    OTLPSpanExporter(endpoint=f"{base}/v1/traces"),
                    schedule_delay_millis=int(
                        os.environ.get("OTEL_BSP_SCHEDULE_DELAY", "2000")
                    ),
                )
            )
            otel_trace.set_tracer_provider(_tracer_provider)
            _tracer = otel_trace.get_tracer(_TRACER_NAME)

            _meter_provider = MeterProvider(
                resource=resource,
                metric_readers=[
                    PeriodicExportingMetricReader(
                        OTLPMetricExporter(endpoint=f"{base}/v1/metrics"),
                        export_interval_millis=int(
                            os.environ.get("OTEL_METRIC_EXPORT_INTERVAL", "60000")
                        ),
                    )
                ],
            )
            otel_metrics.set_meter_provider(_meter_provider)

            _logger_provider = LoggerProvider(resource=resource)
            _logger_provider.add_log_record_processor(
                BatchLogRecordProcessor(OTLPLogExporter(endpoint=f"{base}/v1/logs"))
            )
            set_logger_provider(_logger_provider)
            logging.getLogger().addHandler(
                LoggingHandler(
                    level=logging.INFO, logger_provider=_logger_provider
                )
            )

            atexit.register(shutdown_telemetry)
            _enabled = True
            logger.info("[otel] telemetry live → %s", base)
            return True
        except Exception as exc:  # noqa: BLE001 — observability must never take the agent down
            logger.warning("[otel] init failed, telemetry disabled: %s", exc)
            return False


def _extract_inbound_context() -> Any:
    """W3C context from WORKFLOW_BUILDER_TRACEPARENT/TRACESTATE/BAGGAGE env.

    sandbox-execution-api stamps these onto every agent-host pod via
    downward-API from the pod annotations, carrying the BFF/orchestrator
    trace that also parents the daprd workflow spans.
    """
    global _inbound_context
    if _inbound_context is not None:
        return _inbound_context
    traceparent = (os.environ.get("WORKFLOW_BUILDER_TRACEPARENT") or "").strip()
    if not traceparent:
        _inbound_context = False
        return False
    try:
        from opentelemetry.baggage.propagation import W3CBaggagePropagator
        from opentelemetry.trace.propagation.tracecontext import (
            TraceContextTextMapPropagator,
        )

        carrier = {"traceparent": traceparent}
        tracestate = (os.environ.get("WORKFLOW_BUILDER_TRACESTATE") or "").strip()
        if tracestate:
            carrier["tracestate"] = tracestate
        baggage = (os.environ.get("WORKFLOW_BUILDER_BAGGAGE") or "").strip()
        if baggage:
            carrier["baggage"] = baggage
        ctx = TraceContextTextMapPropagator().extract(carrier=carrier)
        ctx = W3CBaggagePropagator().extract(carrier=carrier, context=ctx)
        _inbound_context = ctx
    except Exception as exc:  # noqa: BLE001
        logger.debug("[otel] inbound trace-context extract failed: %s", exc)
        _inbound_context = False
    return _inbound_context


@contextmanager
def activity_span(name: str, attributes: dict[str, Any] | None = None) -> Iterator[Any]:
    """Open a span for a durable activity, joined to the platform trace.

    Parent resolution: the live current span if one exists (nested use),
    else the inbound WORKFLOW_BUILDER_TRACEPARENT context, else a new root.
    Yields the span (or None when telemetry is disabled — callers must
    tolerate None).
    """
    if not _enabled or _tracer is None:
        yield None
        return

    from opentelemetry import trace as otel_trace

    parent = None
    current = otel_trace.get_current_span()
    if current is None or not current.get_span_context().is_valid:
        inbound = _extract_inbound_context()
        parent = inbound if inbound else None

    with _tracer.start_as_current_span(
        name, context=parent, attributes=attributes or {}
    ) as span:
        yield span


def instrument_model(model: Any) -> Any:
    """Wrap a pydantic-ai model with its native OTel instrumentation."""
    global _instrumentation_settings
    if not _enabled:
        return model
    try:
        from pydantic_ai.models.instrumented import (
            InstrumentationSettings,
            InstrumentedModel,
        )

        if _instrumentation_settings is None:
            _instrumentation_settings = InstrumentationSettings(
                include_content=content_capture_enabled(),
            )
        return InstrumentedModel(model, _instrumentation_settings)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[otel] model instrumentation unavailable: %s", exc)
        return model


def set_content_attr(span: Any, key: str, value: Any) -> None:
    """Set a JSON content attribute with the platform 60KB cap + truncated flag."""
    if span is None or value is None:
        return
    try:
        serialized = (
            value
            if isinstance(value, str)
            else json.dumps(value, default=str, ensure_ascii=False)
        )
        if len(serialized) > MAX_CONTENT_SIZE:
            span.set_attribute(key, serialized[:MAX_CONTENT_SIZE])
            span.set_attribute(f"{key}.truncated", True)
        else:
            span.set_attribute(key, serialized)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[otel] set %s failed: %s", key, exc)


def flush_telemetry(timeout_millis: int = 3000) -> None:
    """Force-flush spans; called at activity end so a reaped pod loses nothing."""
    provider = _tracer_provider
    if provider is None:
        return
    try:
        provider.force_flush(timeout_millis=timeout_millis)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[otel] flush failed: %s", exc)


def shutdown_telemetry() -> None:
    global _enabled
    _enabled = False
    for provider in (_tracer_provider, _meter_provider, _logger_provider):
        if provider is None:
            continue
        try:
            provider.shutdown()
        except Exception:  # noqa: BLE001
            pass
