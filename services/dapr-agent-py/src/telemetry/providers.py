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
from collections.abc import Iterator

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


def is_telemetry_ready() -> bool:
    return _ready


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
                "service.name": os.environ.get("OTEL_SERVICE_NAME", "dapr-agent-py"),
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
        tp.add_span_processor(_NullAttributeSanitizingSpanProcessor())
        tp.add_span_processor(
            BatchSpanProcessor(
                OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces"),
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
            BatchLogRecordProcessor(OTLPLogExporter(endpoint=f"{endpoint}/v1/logs"))
        )
        set_logger_provider(lp)
        _logger_provider = lp
        _event_logger = lp.get_logger(_EVENT_LOGGER_SCOPE)

        # --- DaprAgentsInstrumentor (layer OpenInference on top) ---
        try:
            from dapr_agents.observability import DaprAgentsInstrumentor

            _install_dapr_agents_context_bridge()
            DaprAgentsInstrumentor().instrument(tracer_provider=tp)
            logger.info("DaprAgentsInstrumentor enabled")
        except Exception as exc:  # noqa: BLE001
            logger.warning("DaprAgentsInstrumentor failed: %s", exc)

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


def _iter_context_bridge_attrs(original: Any) -> Iterator[tuple[str, Any]]:
    """Merge OpenInference context with workflow-builder runtime context.

    Dapr Agents' built-in LLM/tool wrappers call a module-local
    `get_attributes_from_context()` while constructing spans like
    `execute_tool Bash`. Their OpenInference context only contains generic
    session/user metadata. Our per-activity runtime context lives in
    `src.telemetry.attributes`, so expose it through the same hook before the
    wrapper snapshots span attributes.
    """
    def _non_null_attrs(items: Any) -> Iterator[tuple[str, Any]]:
        for key, value in items:
            if value is None:
                logger.debug("Dropping null OpenTelemetry attribute from Dapr Agents bridge: %s", key)
                continue
            yield key, value

    try:
        yield from _non_null_attrs(original())
    except Exception as exc:  # noqa: BLE001
        logger.debug("Dapr Agents context bridge original lookup failed: %s", exc)

    try:
        from src.telemetry.attributes import get_telemetry_attributes

        yield from _non_null_attrs(get_telemetry_attributes().items())
    except Exception as exc:  # noqa: BLE001
        logger.debug("Dapr Agents context bridge runtime lookup failed: %s", exc)


def _sanitize_span_attributes(span: Any) -> None:
    """Drop null span attributes before SDK exporters encode them."""
    attrs = getattr(span, "_attributes", None)
    if not attrs:
        return

    try:
        items = list(attrs.items())
    except Exception as exc:  # noqa: BLE001
        logger.debug("Could not inspect span attributes for null cleanup: %s", exc)
        return

    clean_attrs: dict[str, Any] = {}
    dropped_keys: list[str] = []
    for key, value in items:
        if value is None:
            dropped_keys.append(str(key))
            continue
        clean_attrs[key] = value

    if not dropped_keys:
        return

    try:
        setattr(span, "_attributes", clean_attrs)
    except Exception as exc:  # noqa: BLE001
        logger.debug("Could not update span attributes after null cleanup: %s", exc)
        return

    logger.debug("Dropped null OpenTelemetry span attributes: %s", ", ".join(dropped_keys))


class _NullAttributeSanitizingSpanProcessor:
    """Span processor that removes null attrs from third-party instrumentation."""

    def on_start(self, span: Any, parent_context: Any = None) -> None:
        return None

    def on_end(self, span: Any) -> None:
        _sanitize_span_attributes(span)

    def shutdown(self) -> None:
        return None

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return True


def _install_dapr_agents_context_bridge() -> None:
    """Patch Dapr Agents wrappers to include workflow-builder context attrs."""
    for module_name in (
        "dapr_agents.observability.wrappers.llm",
        "dapr_agents.observability.wrappers.tool",
    ):
        try:
            module = __import__(module_name, fromlist=["get_attributes_from_context"])
            original = getattr(module, "get_attributes_from_context", None)
        except Exception as exc:  # noqa: BLE001
            logger.debug("Dapr Agents context bridge skipped for %s: %s", module_name, exc)
            continue
        if original is None or getattr(original, "_workflow_builder_context_bridge", False):
            continue

        def bridged_get_attributes_from_context(
            _original=original,
        ) -> Iterator[tuple[str, Any]]:
            yield from _iter_context_bridge_attrs(_original)

        setattr(bridged_get_attributes_from_context, "_workflow_builder_context_bridge", True)
        setattr(module, "get_attributes_from_context", bridged_get_attributes_from_context)


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
    autolog_anthropic = (
        os.environ.get("DAPR_AGENT_PY_MLFLOW_AUTOLOG_ANTHROPIC", "true")
        .strip()
        .lower()
        not in {"0", "false", "no", "off"}
    )
    if autolog_anthropic:
        try:
            import mlflow.anthropic  # type: ignore[import-not-found]
            mlflow.anthropic.autolog(log_traces=True, silent=True)
            logger.info("MLflow Anthropic autolog enabled (Phase 2b)")
        except Exception as exc:  # noqa: BLE001
            logger.info("MLflow Anthropic autolog skipped (%s)", exc)

    # mlflow.litellm.autolog() — covers MLflow AI Gateway proxied
    # calls. Lower priority for now: until Phase 2c expands the Gateway
    # config with our provider set, the only calls flowing through it
    # are the two existing OpenAI routes. Still cheap to enable so the
    # plumbing is verified end-to-end.
    autolog_litellm = (
        os.environ.get("DAPR_AGENT_PY_MLFLOW_AUTOLOG_LITELLM", "true")
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


def set_mlflow_trace_experiment_for_context(experiment_id: str | None) -> bool:
    """Set a context-local MLflow trace destination for the current workflow turn."""
    tracking_uri = (os.environ.get("MLFLOW_TRACKING_URI") or "").strip()
    experiment_id = (experiment_id or "").strip()
    if not tracking_uri or not experiment_id:
        return False

    try:
        import mlflow
        from mlflow.entities.trace_location import MlflowExperimentLocation
    except Exception as exc:  # noqa: BLE001
        logger.debug("mlflow SDK unavailable; context-local destination skipped (%s)", exc)
        return False

    try:
        mlflow.set_tracking_uri(tracking_uri)
        try:
            mlflow.tracing.set_destination(
                MlflowExperimentLocation(experiment_id=experiment_id),
                context_local=True,
            )
        except TypeError:
            mlflow.tracing.set_destination(
                MlflowExperimentLocation(experiment_id=experiment_id)
            )
        logger.info(
            "MLflow context-local tracing destination set: experiment_id=%s",
            experiment_id,
        )
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to set context-local MLflow tracing destination: %s", exc)
        return False


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
        baggage = (os.environ.get("WORKFLOW_BUILDER_BAGGAGE") or "").strip()
        if baggage:
            carrier["baggage"] = baggage
        parent_ctx = extract(carrier)
        otel_context.attach(parent_ctx)
        logger.info(
            "Attached inbound trace context from BFF (traceparent prefix=%s)",
            traceparent[:35],
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to attach inbound trace context: %s", exc)


def get_tracer():
    """Return the claude_code tracer, or None when telemetry is disabled."""
    if not _ready:
        return None
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
