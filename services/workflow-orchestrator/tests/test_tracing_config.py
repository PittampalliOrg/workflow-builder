from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

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


def _clear_mlflow_env(monkeypatch):
    for name in (
        "WORKFLOW_ORCHESTRATOR_LEGACY_MLFLOW_ENABLED",
        "WORKFLOW_ORCHESTRATOR_MLFLOW_OTLP_ENDPOINT",
        "MLFLOW_TRACKING_URI",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize(
    "legacy_on, endpoint_set, expected",
    [
        # legacy off / endpoint unset -> off (unchanged fleet default)
        (False, False, False),
        # legacy off / endpoint set -> the ONLY new behavior (async preview)
        (False, True, True),
        # legacy on (+ tracking uri) / endpoint unset -> on (back-compat, unchanged)
        (True, False, True),
        # legacy on / endpoint set -> on
        (True, True, True),
    ],
)
def test_otlp_export_gate_matrix(monkeypatch, legacy_on, endpoint_set, expected):
    _clear_mlflow_env(monkeypatch)
    if legacy_on:
        monkeypatch.setenv("WORKFLOW_ORCHESTRATOR_LEGACY_MLFLOW_ENABLED", "true")
        monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://mlflow:5000")
    if endpoint_set:
        monkeypatch.setenv(
            "WORKFLOW_ORCHESTRATOR_MLFLOW_OTLP_ENDPOINT", "http://otel-egress:4318"
        )
    assert tracing._mlflow_otlp_export_enabled() is expected


def test_otlp_endpoint_does_not_reenable_legacy_client(monkeypatch):
    # Setting the async OTLP endpoint must NOT turn the legacy synchronous MLflow
    # SDK client (the one that deadlocked previews) back on.
    _clear_mlflow_env(monkeypatch)
    monkeypatch.setenv(
        "WORKFLOW_ORCHESTRATOR_MLFLOW_OTLP_ENDPOINT", "http://otel-egress:4318"
    )
    assert tracing._mlflow_otlp_export_enabled() is True
    assert tracing._mlflow_enabled() is False


def test_root_span_export_failure_does_not_raise(monkeypatch):
    # The bounded OTLP export must be non-blocking + catch-all: a transport
    # failure returns a result dict, never raises into the workflow activity.
    _clear_mlflow_env(monkeypatch)
    monkeypatch.setenv(
        "WORKFLOW_ORCHESTRATOR_MLFLOW_OTLP_ENDPOINT", "http://unreachable:4318"
    )

    def _boom(*_args, **_kwargs):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(tracing.requests, "post", _boom, raising=False)

    result = tracing.emit_mlflow_trace_root_span(
        {"traceId": "a" * 32, "daprInstanceId": "wf-instance-1", "workflowId": "wf-1"}
    )
    assert isinstance(result, dict)
    assert result.get("success") is False
