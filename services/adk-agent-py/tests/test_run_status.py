from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from src.run_status import AgentRunNotFoundError, resolve_agent_run_status
from src.session_config import (
    SESSION_CONFIG_UPDATE_EVENT,
    apply_session_control_events,
    external_control_event_as_user_event,
    session_event_batch,
)


class FakeClient:
    def __init__(self, state):
        self.state = state
        self.calls: list[tuple[str, bool]] = []

    def get_workflow_state(self, instance_id: str, *, fetch_payloads: bool):
        self.calls.append((instance_id, fetch_payloads))
        return self.state


def workflow_state(status: str = "RUNNING"):
    return SimpleNamespace(
        runtime_status=SimpleNamespace(name=status),
        serialized_input='{"task":"test"}',
        serialized_output='{"ok":true}',
    )


@pytest.mark.parametrize(("summary", "fetch_payloads"), [(True, False), (False, True)])
def test_status_contract_controls_payload_loading(summary: bool, fetch_payloads: bool):
    client = FakeClient(workflow_state())

    result = resolve_agent_run_status(
        "session-1",
        summary=summary,
        app_id="agent-session-abc",
        client_factory=lambda: client,
    )

    assert client.calls == [("session-1", fetch_payloads)]
    assert result["runtimeStatus"] == "RUNNING"
    assert result["runtime_status"] == "RUNNING"
    assert result["phase"] == "running"
    assert result["appId"] == "agent-session-abc"
    assert ("input" in result) is not summary
    assert ("outputs" in result) is not summary
    if not summary:
        assert result["input"] == '{"task":"test"}'
        assert result["outputs"] == '{"ok":true}'


def test_missing_workflow_raises_domain_error():
    with pytest.raises(AgentRunNotFoundError, match="^Agent run not found$"):
        resolve_agent_run_status(
            "missing",
            summary=True,
            app_id="agent-session-abc",
            client_factory=lambda: FakeClient(None),
        )


def test_main_exposes_complete_agent_run_contract():
    source = (Path(__file__).parents[1] / "src/main.py").read_text()

    assert '@app.get("/api/v2/agent-runs/{instance_id}/status")' in source
    assert '@app.post("/api/v2/agent-runs/{instance_id}/terminate")' in source
    assert '@app.post("/api/v2/agent-runs/{instance_id}/pause")' in source
    assert '@app.post("/api/v2/agent-runs/{instance_id}/resume")' in source
    assert '@app.delete("/api/v2/agent-runs/{instance_id}")' in source
    assert "client_factory=DaprWorkflowClient" in source
    assert "except AgentRunNotFoundError" in source
    assert 'HTTPException(status_code=404, detail=str(exc))' in source
    assert "DaprWorkflowClient().terminate_workflow(" in source
    assert "DaprWorkflowClient().pause_workflow(" in source
    assert "DaprWorkflowClient().resume_workflow(" in source
    assert "DaprWorkflowClient().purge_workflow(" in source


def test_terminal_control_uses_the_batch_lane_consumed_by_the_workflow():
    event_name, payload = external_control_event_as_user_event(
        "session.terminate", {"reason": "stop"}
    )

    assert event_name == "session.user_events"
    assert session_event_batch(payload) == [
        {"type": "session.terminate", "reason": "stop"}
    ]
    workflow_source = (
        Path(__file__).parents[1] / "src/runner/session_workflow.py"
    ).read_text()
    assert "events = session_event_batch(payload)" in workflow_source
    assert "agent_config, events, _ = apply_session_control_events(" in workflow_source


def test_config_control_uses_the_same_batch_lane():
    event_name, payload = external_control_event_as_user_event(
        SESSION_CONFIG_UPDATE_EVENT,
        {"patch": {"modelSpec": "kimi/kimi-k3"}},
    )

    assert event_name == "session.user_events"
    agent_config, remaining, applied = apply_session_control_events(
        {"modelSpec": "old-model"}, session_event_batch(payload)
    )
    assert agent_config["modelSpec"] == "kimi/kimi-k3"
    assert remaining == []
    assert applied == [
        {"type": SESSION_CONFIG_UPDATE_EVENT, "changedKeys": ["modelSpec"]}
    ]
