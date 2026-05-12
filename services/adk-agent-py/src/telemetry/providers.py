"""OpenTelemetry provider bootstrap.

Ports the setup in `claude-code-src/main/dapr/preload.mjs` and
`utils/telemetry/instrumentation.ts`:

- TracerProvider with OTLP HTTP span exporter (BatchSpanProcessor)
- MeterProvider with OTLP HTTP metric exporter (PeriodicExportingMetricReader)
- LoggerProvider with OTLP HTTP log exporter (BatchLogRecordProcessor)
- W3C TraceContext propagator (Python SDK registers this by default)
- Graceful shutdown/flush with `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS`

Runs at import time of `main.py` (before FastAPI app creation). The
`DaprAgentsInstrumentor()` hook is preserved from the previous bootstrap so
OpenInference LLM/tool/agent spans continue to flow.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

_TRACER_SCOPE = "com.anthropic.claude_code.tracing"
_TRACER_VERSION = "1.0.0"
_EVENT_LOGGER_SCOPE = "com.anthropic.claude_code.events"
_METER_SCOPE = "com.anthropic.claude_code.metrics"

_tracer_provider: Any = None
_meter_provider: Any = None
_logger_provider: Any = None
_event_logger: Any = None
_ready = False


def _valid_attr_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, (list, tuple)):
        return all(item is not None for item in value)
    return True


def _clean_attrs(attrs: Any) -> dict[str, Any] | None:
    if not attrs:
        return None
    return {
        str(key): value
        for key, value in dict(attrs).items()
        if _valid_attr_value(value)
    }


class _SanitizingSpanExporter:
    """Drop invalid OTel attributes before handing spans to OTLP encoding."""

    def __init__(self, wrapped: Any) -> None:
        self._wrapped = wrapped

    def export(self, spans: Any) -> Any:
        return self._wrapped.export([self._sanitize_span(span) for span in spans])

    def shutdown(self) -> Any:
        return self._wrapped.shutdown()

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        force_flush = getattr(self._wrapped, "force_flush", None)
        if force_flush is None:
            return True
        return bool(force_flush(timeout_millis=timeout_millis))

    def _sanitize_span(self, span: Any) -> Any:
        attrs = _clean_attrs(getattr(span, "attributes", None))
        original_attrs = getattr(span, "attributes", None)
        if attrs == original_attrs:
            return span
        try:
            from opentelemetry.sdk.trace import ReadableSpan

            return ReadableSpan(
                name=span.name,
                context=span.context,
                parent=span.parent,
                resource=span.resource,
                attributes=attrs,
                events=span.events,
                links=span.links,
                kind=span.kind,
                instrumentation_info=span.instrumentation_info,
                status=span.status,
                start_time=span.start_time,
                end_time=span.end_time,
                instrumentation_scope=span.instrumentation_scope,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("Failed to sanitize span %s: %s", getattr(span, "name", "?"), exc)
            return span


class _SanitizingSpanProcessor:
    """Remove invalid attributes before downstream processors/exporters run."""

    def on_start(self, span: Any, parent_context: Any | None = None) -> None:
        return None

    def on_end(self, span: Any) -> None:
        attrs = _clean_attrs(getattr(span, "attributes", None))
        original_attrs = getattr(span, "attributes", None)
        if attrs == original_attrs:
            return
        try:
            setattr(span, "_attributes", attrs)
        except Exception as exc:  # noqa: BLE001
            logger.debug("Failed to sanitize ended span %s: %s", getattr(span, "name", "?"), exc)

    def shutdown(self) -> None:
        return None

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return True


class _SanitizingLogExporter:
    """Drop invalid OTel log attributes before OTLP log encoding."""

    def __init__(self, wrapped: Any) -> None:
        self._wrapped = wrapped

    def export(self, batch: Any) -> Any:
        for record in batch:
            try:
                log_record = record.log_record
                attrs = _clean_attrs(getattr(log_record, "attributes", None))
                setattr(log_record, "attributes", attrs)
            except Exception as exc:  # noqa: BLE001
                logger.debug("Failed to sanitize log record: %s", exc)
        return self._wrapped.export(batch)

    def shutdown(self) -> Any:
        return self._wrapped.shutdown()

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        force_flush = getattr(self._wrapped, "force_flush", None)
        if force_flush is None:
            return True
        return bool(force_flush(timeout_millis=timeout_millis))


def is_telemetry_ready() -> bool:
    return _ready


def telemetry_debug_state() -> dict[str, Any]:
    """Small diagnostic snapshot for tracing bootstrap logs."""
    try:
        from opentelemetry import trace

        global_provider = type(trace.get_tracer_provider()).__name__
    except Exception as exc:  # noqa: BLE001
        global_provider = f"<unavailable: {exc}>"

    return {
        "ready": _ready,
        "configured_provider": type(_tracer_provider).__name__ if _tracer_provider else None,
        "global_provider": global_provider,
        "otel_endpoint": bool((os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()),
        "mlflow_tracking_uri": bool((os.environ.get("MLFLOW_TRACKING_URI") or "").strip()),
        "mlflow_experiment_id": bool(
            (os.environ.get("MLFLOW_TRACE_EXPERIMENT_ID") or "").strip()
        ),
    }


def _parse_int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError:
        logger.warning("Invalid int for %s=%r, using default %d", name, raw, default)
        return default


def init_telemetry() -> bool:
    """Initialize tracer + meter + logger providers.

    Returns True on success, False when the OTLP endpoint is unset or setup
    fails. Safe to call multiple times; subsequent calls are no-ops.
    """
    global _tracer_provider, _meter_provider, _logger_provider, _event_logger, _ready
    if _ready:
        return True

    endpoint = (os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()
    if not endpoint:
        logger.info("OTEL_EXPORTER_OTLP_ENDPOINT not set, skipping telemetry init")
        return False

    endpoint = endpoint.rstrip("/")
    try:
        from opentelemetry import trace, metrics
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
        from opentelemetry.sdk._logs import LoggerProvider
        from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        resource = Resource.create(
            {
                "service.name": os.environ.get("OTEL_SERVICE_NAME", "adk-agent-py"),
                "service.namespace": "workflow-builder",
                "openinference.project.name": "workflow-builder",
            }
        )

        # --- Tracer ---
        # Long SWE-bench turns produce hundreds of child spans before the root
        # `claude_code.interaction` span ends. The default queue (2048) and
        # batch size (512) silently drop spans under that load, leaving the
        # root span trapped in MLflow as `IN_PROGRESS`. Bump both, and let env
        # overrides win.
        bsp_queue = _parse_int_env("OTEL_BSP_MAX_QUEUE_SIZE", 8192)
        bsp_batch = _parse_int_env("OTEL_BSP_MAX_EXPORT_BATCH_SIZE", 2048)
        bsp_delay = _parse_int_env("OTEL_BSP_SCHEDULE_DELAY", 5_000)
        tp = TracerProvider(resource=resource)
        tp.add_span_processor(_SanitizingSpanProcessor())
        tp.add_span_processor(
            BatchSpanProcessor(
                _SanitizingSpanExporter(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces")),
                max_queue_size=bsp_queue,
                max_export_batch_size=bsp_batch,
                schedule_delay_millis=bsp_delay,
            )
        )
        trace.set_tracer_provider(tp)
        _tracer_provider = tp

        # --- MLflow tracing destination ---
        # Add MLflow as an ADDITIONAL span processor on the TracerProvider
        # so spans go to BOTH the OTEL Collector (ClickHouse + Tempo) AND
        # MLflow's tracking server. MLflow's `set_destination()` writes
        # trace_request_metadata that the search/UI API requires — the
        # collector's otlphttp/mlflow path stores spans but is
        # search-invisible. Setting MLFLOW_USE_DEFAULT_TRACER_PROVIDER=false
        # tells mlflow to attach its processor to our TP instead of
        # installing its own.
        os.environ.setdefault("MLFLOW_USE_DEFAULT_TRACER_PROVIDER", "false")
        _init_mlflow_destination()

        # --- Inbound W3C trace-context (BFF -> sandbox-execution-api -> here) ---
        # The Sandbox manifest stamps the parent BFF traceparent on the pod's
        # downward-API env vars so spans emitted from session_workflow chain
        # back to the original workflow run instead of starting a new root.
        _attach_inbound_trace_context()

        # --- Meter ---
        export_interval_ms = _parse_int_env("OTEL_METRIC_EXPORT_INTERVAL", 60_000)
        reader = PeriodicExportingMetricReader(
            OTLPMetricExporter(endpoint=f"{endpoint}/v1/metrics"),
            export_interval_millis=export_interval_ms,
        )
        mp = MeterProvider(resource=resource, metric_readers=[reader])
        metrics.set_meter_provider(mp)
        _meter_provider = mp

        # --- Logger ---
        lp = LoggerProvider(resource=resource)
        lp.add_log_record_processor(
            BatchLogRecordProcessor(
                _SanitizingLogExporter(OTLPLogExporter(endpoint=f"{endpoint}/v1/logs"))
            )
        )
        set_logger_provider(lp)
        _logger_provider = lp
        _event_logger = lp.get_logger(_EVENT_LOGGER_SCOPE)

        # No `DaprAgentsInstrumentor` for adk-agent-py — that's a
        # dapr-agents-specific OpenInference wrapper for the classic runtime.
        # Instead, the Diagrid ADK plugin emits
        # its own `LLM.generate_content` / `Tool.execute` spans via
        # `diagrid.agent.core.telemetry.get_tracer("adk.agent")`; `adk_spans`
        # layers wrapping `adk_agent.session` / `adk_agent.turn` spans on top.

        _ready = True
        logger.info(
            "Telemetry initialized: traces+metrics+logs -> %s (metric interval %dms)",
            endpoint,
            export_interval_ms,
        )
        return True

    except Exception as exc:  # noqa: BLE001
        logger.warning("OpenTelemetry init failed: %s", exc)
        return False


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
            "MLflow tracing destination skipped (MLFLOW_TRACKING_URI=%r, "
            "MLFLOW_TRACE_EXPERIMENT_ID=%r)",
            tracking_uri or "<unset>",
            experiment_id or "<unset>",
        )
        return

    try:
        import mlflow
        from mlflow.entities.trace_location import MlflowExperimentLocation
    except Exception as exc:  # noqa: BLE001
        logger.info("mlflow SDK unavailable; MLflow tracing destination skipped (%s)", exc)
        return

    try:
        mlflow.set_tracking_uri(tracking_uri)
        mlflow.tracing.set_destination(MlflowExperimentLocation(experiment_id=experiment_id))
        logger.info(
            "MLflow tracing destination set: experiment_id=%s tracking_uri=%s",
            experiment_id,
            tracking_uri,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to set MLflow tracing destination: %s", exc)
        return

    # --- Phase 2b: provider-level autolog ------------------------------
    # mlflow.anthropic.autolog() instruments every Anthropic Python SDK
    # call (Messages, Tool Use, structured prompts) and emits child
    # spans under our existing claude_code.interaction roll-up. Combined
    # with MLFLOW_ENABLE_OTEL_GENAI_SEMCONV=true (Phase 2a, ConfigMap),
    # the autolog span attributes get translated to standard OTel
    # gen_ai.* keys on OTLP export — making the same data queryable
    # from ClickHouse + Tempo without provider-specific glue.
    #
    # Gated by DAPR_AGENT_PY_MLFLOW_AUTOLOG_ANTHROPIC=true (default true
    # on dev for soak; can disable per-env via configmap if needed).
    # Anthropic autolog is irrelevant for adk-agent-py (Gemini-only by
    # default). LiteLLM autolog below stays — it covers ADK agents
    # configured with `provider="litellm"` (Claude / OpenAI / etc.).
    autolog_anthropic = False
    if False:  # kept for diff symmetry with dapr-agent-py
        pass

    # mlflow.litellm.autolog() — covers MLflow AI Gateway proxied
    # calls. Lower priority for now: until Phase 2c expands the Gateway
    # config with our provider set, the only calls flowing through it
    # are the two existing OpenAI routes. Still cheap to enable so the
    # plumbing is verified end-to-end.
    autolog_litellm = (
        os.environ.get("ADK_AGENT_PY_MLFLOW_AUTOLOG_LITELLM", "true")
        .strip()
        .lower()
        not in {"0", "false", "no", "off"}
    )
    if autolog_litellm:
        try:
            import mlflow.litellm  # type: ignore[import-not-found]
            mlflow.litellm.autolog(log_traces=True, silent=True)
            logger.info("MLflow LiteLLM autolog enabled (Phase 2b/2c)")
        except Exception as exc:  # noqa: BLE001
            logger.info("MLflow LiteLLM autolog skipped (%s)", exc)


def _attach_inbound_trace_context() -> None:
    """Honor WORKFLOW_BUILDER_TRACEPARENT/TRACESTATE downward-API env vars.

    When the BFF forwards a W3C traceparent on the inbound provisioning call,
    sandbox-execution-api stamps it on the Sandbox metadata.annotations and
    surfaces it here as env. We extract it once at startup and attach the
    resulting context globally; later spans (without an explicit parent) chain
    to the BFF root and Tempo / Phoenix can render the full trace.
    """
    traceparent = (os.environ.get("WORKFLOW_BUILDER_TRACEPARENT") or "").strip()
    if not traceparent:
        return
    try:
        from opentelemetry import context as otel_context
        from opentelemetry.propagate import extract

        carrier: dict[str, str] = {"traceparent": traceparent}
        tracestate = (os.environ.get("WORKFLOW_BUILDER_TRACESTATE") or "").strip()
        if tracestate:
            carrier["tracestate"] = tracestate
        parent_ctx = extract(carrier)
        otel_context.attach(parent_ctx)
        logger.info(
            "Attached inbound trace context from BFF (traceparent prefix=%s)",
            traceparent[:35],
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to attach inbound trace context: %s", exc)


def get_tracer():
    """Return the active tracer.

    The ADK stack may install an OpenTelemetry provider before this module is
    fully marked ready. Returning the global tracer keeps activity-level
    enrichment working even when metrics setup logs a provider override.
    """
    if _tracer_provider is not None:
        return _tracer_provider.get_tracer(_TRACER_SCOPE, _TRACER_VERSION)

    from opentelemetry import trace
    return trace.get_tracer(_TRACER_SCOPE, _TRACER_VERSION)


def get_meter():
    if not _ready:
        return None
    from opentelemetry import metrics

    return metrics.get_meter(_METER_SCOPE, _TRACER_VERSION)


def get_event_logger():
    """Return the `com.anthropic.claude_code.events` logger, or None."""
    if not _ready:
        return None
    return _event_logger


def flush_telemetry(timeout_ms: int | None = None) -> None:
    """Force the tracer's BatchSpanProcessor to flush pending spans.

    Call after ending the root `claude_code.interaction` span at the end of
    an agent_workflow turn so the root span doesn't sit in the queue past the
    activity return — which is what leaves MLflow traces stuck in
    `IN_PROGRESS` with no root.
    """
    if not _ready or _tracer_provider is None:
        return
    effective = timeout_ms if timeout_ms is not None else _parse_int_env(
        "CLAUDE_CODE_OTEL_FLUSH_TIMEOUT_MS", 5_000
    )
    try:
        flush = getattr(_tracer_provider, "force_flush", None)
        if flush:
            flush(timeout_millis=effective)
    except Exception as exc:  # noqa: BLE001
        logger.warning("flush_telemetry failed: %s", exc)


def shutdown_telemetry() -> None:
    """Flush and shut down all providers. Bounded by CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS."""
    global _ready
    if not _ready:
        return
    timeout_ms = _parse_int_env("CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS", 2_000)

    # force_flush first (give exporters a chance to push pending data), then shutdown.
    for name, provider in (
        ("tracer", _tracer_provider),
        ("meter", _meter_provider),
        ("logger", _logger_provider),
    ):
        if provider is None:
            continue
        try:
            flush = getattr(provider, "force_flush", None)
            if flush:
                flush(timeout_millis=timeout_ms)
        except Exception as exc:  # noqa: BLE001
            logger.warning("%s force_flush failed: %s", name, exc)

    for name, provider in (
        ("tracer", _tracer_provider),
        ("meter", _meter_provider),
        ("logger", _logger_provider),
    ):
        if provider is None:
            continue
        try:
            shutdown = getattr(provider, "shutdown", None)
            if shutdown:
                # Some providers don't accept a timeout kw; call both ways.
                try:
                    shutdown(timeout_millis=timeout_ms)
                except TypeError:
                    shutdown()
        except Exception as exc:  # noqa: BLE001
            logger.warning("%s shutdown failed: %s", name, exc)

    _ready = False
