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
        tp = TracerProvider(resource=resource)
        tp.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces"))
        )
        trace.set_tracer_provider(tp)
        _tracer_provider = tp

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
