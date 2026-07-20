from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import tracing  # noqa: E402


def test_otel_signal_export_enabled_respects_none(monkeypatch):
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "none")
    monkeypatch.setenv("OTEL_METRICS_EXPORTER", "otlp")
    monkeypatch.delenv("OTEL_LOGS_EXPORTER", raising=False)

    assert tracing._otel_signal_export_enabled("traces") is False
    assert tracing._otel_signal_export_enabled("metrics") is True
    assert tracing._otel_signal_export_enabled("logs") is True


def test_otlp_endpoint_uses_only_canonical_otel_configuration(monkeypatch):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://otel-collector:4318")
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://retired-mlflow:5000")
    monkeypatch.setenv(
        "WORKFLOW_ORCHESTRATOR_MLFLOW_OTLP_ENDPOINT",
        "http://retired-mlflow-egress:4318",
    )

    assert tracing._otlp_endpoint_for("traces") == (
        "http://otel-collector:4318/v1/traces"
    )


def test_retired_mlflow_environment_cannot_enable_export(monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://retired-mlflow:5000")
    monkeypatch.setenv("WORKFLOW_ORCHESTRATOR_LEGACY_MLFLOW_ENABLED", "true")
    monkeypatch.setenv(
        "WORKFLOW_ORCHESTRATOR_MLFLOW_OTLP_ENDPOINT",
        "http://retired-mlflow-egress:4318",
    )

    assert tracing._otlp_endpoint_for("traces") == ""
