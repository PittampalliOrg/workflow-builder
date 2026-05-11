from __future__ import annotations

import json
import logging
import os
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional


logger = logging.getLogger(__name__)

_TRACING_INITIALIZED = False
SESSION_ID_ATTRIBUTE = "session.id"
WORKFLOW_EXECUTION_ATTRIBUTE = "workflow.execution.id"


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


def _otlp_endpoint_for(signal: str) -> str:
    base = (os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip().rstrip("/")
    if not base:
        return ""
    if base.endswith(f"/v1/{signal}"):
        return base
    return f"{base}/v1/{signal}"


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


def _init_mlflow_destination() -> None:
    """Add MLflow as a span destination on the active TracerProvider.

    No-op when `mlflow` isn't installed or when
    `MLFLOW_TRACKING_URI`/`MLFLOW_TRACE_EXPERIMENT_ID` aren't set.
    Failures are logged but never raise — tracing must stay best-effort.
    """
    tracking_uri = (os.environ.get("MLFLOW_TRACKING_URI") or "").strip()
    experiment_id = (os.environ.get("MLFLOW_TRACE_EXPERIMENT_ID") or "").strip()
    if not tracking_uri or not experiment_id:
        logger.info(
            "[Tracing] MLflow destination skipped "
            "(MLFLOW_TRACKING_URI=%r, MLFLOW_TRACE_EXPERIMENT_ID=%r)",
            tracking_uri or "<unset>",
            experiment_id or "<unset>",
        )
        return

    try:
        import mlflow
        from mlflow.entities.trace_location import MlflowExperimentLocation
    except Exception as exc:  # noqa: BLE001
        logger.info("[Tracing] mlflow SDK unavailable; MLflow destination skipped (%s)", exc)
        return

    try:
        mlflow.set_tracking_uri(tracking_uri)
        mlflow.tracing.set_destination(MlflowExperimentLocation(experiment_id=experiment_id))
        logger.info(
            "[Tracing] MLflow destination set: experiment_id=%s tracking_uri=%s",
            experiment_id,
            tracking_uri,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[Tracing] Failed to set MLflow destination: %s", exc)
        return

    # --- Phase 2b: provider-level autolog ------------------------------
    # Orchestrator rarely calls LLM SDKs directly (most LLM traffic
    # flows through dapr-agent-py), but enable autolog so the rare
    # paths (e.g. swebench-coordinator dispatch) get full trace
    # coverage. Combined with MLFLOW_ENABLE_OTEL_GENAI_SEMCONV=true
    # (Phase 2a) the autolog span attrs get translated to standard
    # gen_ai.* keys on OTLP export.
    if os.environ.get("WORKFLOW_ORCHESTRATOR_MLFLOW_AUTOLOG", "true").strip().lower() not in {
        "0", "false", "no", "off"
    }:
        try:
            import mlflow.anthropic  # type: ignore[import-not-found]
            mlflow.anthropic.autolog(log_traces=True, silent=True)
            logger.info("[Tracing] MLflow Anthropic autolog enabled (Phase 2b)")
        except Exception as exc:  # noqa: BLE001
            logger.info("[Tracing] MLflow Anthropic autolog skipped (%s)", exc)
        try:
            import mlflow.litellm  # type: ignore[import-not-found]
            mlflow.litellm.autolog(log_traces=True, silent=True)
            logger.info("[Tracing] MLflow LiteLLM autolog enabled (Phase 2b/2c)")
        except Exception as exc:  # noqa: BLE001
            logger.info("[Tracing] MLflow LiteLLM autolog skipped (%s)", exc)


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

    endpoint = (os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()
    if not endpoint:
        logger.info("[Tracing] OTEL_EXPORTER_OTLP_ENDPOINT not set; tracing disabled")
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

    # Add MLflow as an ADDITIONAL span destination on the same TP. The
    # OTEL Collector path (BatchSpanProcessor above) keeps sending to
    # ClickHouse + Tempo; MLflow's `set_destination()` adds a processor
    # that writes trace_request_metadata so traces are searchable via
    # mlflow.search_traces() and visible in the MLflow UI. The
    # otlphttp/mlflow collector exporter alone doesn't write that
    # metadata — see project_mlflow_otlp_search_gap.md memory.
    os.environ.setdefault("MLFLOW_USE_DEFAULT_TRACER_PROVIDER", "false")
    _init_mlflow_destination()

    metric_reader = PeriodicExportingMetricReader(
        OTLPMetricExporter(
            endpoint=_otlp_endpoint_for("metrics"),
            headers=headers,
        )
    )
    meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
    metrics.set_meter_provider(meter_provider)

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
    logger.info("[Tracing] OpenTelemetry enabled (OTLP HTTP)")
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
    # Promote to MLflow trace tags so search filters work
    # (Phase 1 of research-the-most-popular-stateful-hinton.md).
    # `update_current_trace` is a no-op when MLflow SDK isn't initialised
    # (e.g. unit-test contexts), so the call is best-effort and never
    # raises.
    set_mlflow_trace_tags({
        SESSION_ID_ATTRIBUTE: session_id,
        WORKFLOW_EXECUTION_ATTRIBUTE: session_id,
        "dapr.workflow.instance_id": session_id,
    })


def set_mlflow_trace_tags(tags: dict[str, Any]) -> None:
    """Promote a curated tag dict onto the active MLflow trace.

    Two-stage approach because MLflow's `update_current_trace()` only
    works when an MLflow-managed tracing context is active — which it
    isn't for spans created via the bare OTel `tracer.start_as_current_span`
    API (our case for Dapr workflow activities). The warning
    "No active trace found" surfaces when called without that context.

    Strategy:
      1. Try `mlflow.update_current_trace(...)` — cheap, works for
         `@mlflow.trace`-decorated paths.
      2. ALSO call `MlflowClient().set_trace_tag(trace_id, k, v)` per
         tag using the OTel-derived trace_id (translated to MLflow's
         `tr-<hex>` format).

    Best-effort: silent no-op when mlflow isn't installed or no OTel
    span is active. Skips empty/None values. Strings only.
    """
    if not tags:
        return
    clean = {
        k: str(v).strip()
        for k, v in tags.items()
        if v is not None and isinstance(v, (str, int, float))
        and str(v).strip()
    }
    if not clean:
        return
    try:
        import mlflow  # type: ignore[import-not-found]
    except Exception:
        return
    session_id = clean.pop("session.id", None)

    # Try fluent API first (works when MLflow tracing context is active).
    try:
        if session_id:
            mlflow.update_current_trace(tags=clean, session_id=session_id)
        else:
            mlflow.update_current_trace(tags=clean)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[Tracing] update_current_trace failed (will fall back to set_trace_tag): %s", exc)

    # Always also call set_trace_tag via the OTel-derived trace_id.
    try:
        from opentelemetry import trace as ot_trace
        span = ot_trace.get_current_span()
        if span is None:
            return
        ctx = span.get_span_context()
        if not ctx or ctx.trace_id == 0:
            return
        mlflow_trace_id = f"tr-{format(ctx.trace_id, '032x')}"
        client = mlflow.MlflowClient()
        if session_id:
            clean["session.id"] = session_id
        for k, v in clean.items():
            try:
                client.set_trace_tag(mlflow_trace_id, k, v)
            except Exception as exc:  # noqa: BLE001
                logger.debug("[Tracing] client.set_trace_tag(%s)=%s failed: %s", k, v, exc)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[Tracing] set_trace_tag fallback path failed: %s", exc)


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
