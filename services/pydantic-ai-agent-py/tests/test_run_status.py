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


def test_summary_status_uses_shared_contract_without_loading_payloads():
    client = FakeClient(workflow_state())

    result = resolve_agent_run_status(
        "session-1",
        summary=True,
        app_id="agent-session-abc",
        client_factory=lambda: client,
    )

    assert client.calls == [("session-1", False)]
    assert result == {
        "instanceId": "session-1",
        "appId": "agent-session-abc",
        "runtimeStatus": "RUNNING",
        "runtime_status": "RUNNING",
        "phase": "running",
    }


def test_detailed_status_includes_serialized_payloads():
    client = FakeClient(workflow_state("COMPLETED"))

    result = resolve_agent_run_status(
        "session-1",
        summary=False,
        app_id="agent-session-abc",
        client_factory=lambda: client,
    )

    assert client.calls == [("session-1", True)]
    assert result["runtimeStatus"] == "COMPLETED"
    assert result["input"] == '{"task":"test"}'
    assert result["outputs"] == '{"ok":true}'


def test_missing_workflow_raises_domain_error():
    client = FakeClient(None)

    with pytest.raises(AgentRunNotFoundError, match="^Agent run not found$"):
        resolve_agent_run_status(
            "missing",
            summary=True,
            app_id="agent-session-abc",
            client_factory=lambda: client,
        )


def test_main_translates_missing_run_to_the_precise_404():
    source = (Path(__file__).parents[1] / "src/main.py").read_text()

    assert "except AgentRunNotFoundError" in source
    assert 'HTTPException(status_code=404, detail=str(exc))' in source
