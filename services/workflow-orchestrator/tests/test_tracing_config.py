from __future__ import annotations

import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

sys.modules.setdefault("requests", types.SimpleNamespace())

import tracing


def test_otel_signal_export_enabled_respects_none(monkeypatch):
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "none")
    monkeypatch.setenv("OTEL_METRICS_EXPORTER", "otlp")
    monkeypatch.delenv("OTEL_LOGS_EXPORTER", raising=False)

    assert tracing._otel_signal_export_enabled("traces") is False
    assert tracing._otel_signal_export_enabled("metrics") is True
    assert tracing._otel_signal_export_enabled("logs") is True


def test_legacy_mlflow_gate_ignores_old_enabled_flag(monkeypatch):
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://mlflow:5000")
    monkeypatch.setenv("MLFLOW_ENABLED", "true")
    monkeypatch.delenv("WORKFLOW_ORCHESTRATOR_LEGACY_MLFLOW_ENABLED", raising=False)

    assert tracing._mlflow_enabled() is False


def test_legacy_mlflow_gate_requires_explicit_flag_and_tracking_uri(monkeypatch):
    monkeypatch.setenv("WORKFLOW_ORCHESTRATOR_LEGACY_MLFLOW_ENABLED", "true")
    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)

    assert tracing._mlflow_enabled() is False

    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://mlflow:5000")
    assert tracing._mlflow_enabled() is True
