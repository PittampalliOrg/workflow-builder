from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from src.run_status import AgentRunNotFoundError, resolve_agent_run_status


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


def test_main_exposes_read_only_status_and_valid_pause_contract():
    source = (Path(__file__).parents[1] / "src/main.py").read_text()

    assert '@app.get("/api/v2/agent-runs/{instance_id}/status")' in source
    assert "client_factory=DaprWorkflowClient" in source
    assert "except AgentRunNotFoundError" in source
    assert 'HTTPException(status_code=404, detail=str(exc))' in source
    assert "DaprWorkflowClient().pause_workflow(" in source
    assert ".suspend_workflow(" not in source
