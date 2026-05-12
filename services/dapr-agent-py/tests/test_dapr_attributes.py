from __future__ import annotations

import os
import sys
import types


root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

from src.telemetry import dapr_attributes  # noqa: E402


def test_set_mlflow_trace_tags_uses_explicit_trace_id(monkeypatch) -> None:
    calls = []

    class FakeClient:
        def set_trace_tag(self, trace_id, key, value):
            calls.append((trace_id, key, value))

    mlflow_module = types.ModuleType("mlflow")
    mlflow_module.MlflowClient = FakeClient
    mlflow_module.update_current_trace = lambda *args, **kwargs: None
    monkeypatch.setitem(sys.modules, "mlflow", mlflow_module)

    dapr_attributes.set_mlflow_trace_tags(
        {"session.id": "session_1", "agent.slug": "coder"},
        trace_name="agent.coder/session.session_1",
        trace_id_hex="1234567890abcdef1234567890abcdef",
    )

    assert (
        "tr-1234567890abcdef1234567890abcdef",
        "agent.slug",
        "coder",
    ) in calls
    assert (
        "tr-1234567890abcdef1234567890abcdef",
        "mlflow.traceName",
        "agent.coder/session.session_1",
    ) in calls


def test_set_mlflow_trace_tags_falls_back_to_env_traceparent(monkeypatch) -> None:
    calls = []
    trace_id = "abcdefabcdefabcdefabcdefabcdefab"

    class FakeClient:
        def set_trace_tag(self, trace_id, key, value):
            calls.append((trace_id, key, value))

    mlflow_module = types.ModuleType("mlflow")
    mlflow_module.MlflowClient = FakeClient
    mlflow_module.update_current_trace = lambda *args, **kwargs: None
    monkeypatch.setitem(sys.modules, "mlflow", mlflow_module)
    monkeypatch.setenv(
        "WORKFLOW_BUILDER_TRACEPARENT",
        f"00-{trace_id}-1234567890abcdef-01",
    )

    dapr_attributes.set_mlflow_trace_tags({"agent.slug": "coder"})

    assert calls == [("tr-" + trace_id, "agent.slug", "coder")]
