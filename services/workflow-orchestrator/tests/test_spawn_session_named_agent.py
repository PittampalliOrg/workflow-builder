"""Named-agent fail-closed refusals in the ensure-for-workflow bridge
(cutover P1e, docs/code-first-cutover.md item 9).

The billing invariant under test: a script's ``agent(..., {agent: slug})``
must NEVER silently dispatch on the metered default runtime — an unknown
slug OR an old BFF that ignores ``resolveAgentSlug`` both refuse (the pump
journals the call as null)."""
from __future__ import annotations

import json

import pytest

import activities.spawn_session as ss


class FakeResponse:
    def __init__(self, status_code: int, body):
        self.status_code = status_code
        self.text = body if isinstance(body, str) else json.dumps(body)

    def json(self):
        return json.loads(self.text)


@pytest.fixture(autouse=True)
def bridge_env(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_TOKEN", "test-token")


def _payload(**over):
    p = {
        "sessionId": "s1",
        "workflowId": "w1",
        "nodeId": "n1",
        "userId": "u1",
        "projectId": "p1",
        "agentConfig": {"runtime": "dapr-agent-py"},
    }
    p.update(over)
    return p


def test_unknown_slug_422_returns_refusal_not_raise(monkeypatch):
    monkeypatch.setattr(
        ss.requests,
        "post",
        lambda *a, **k: FakeResponse(
            422, {"code": "agent_ref_unresolved", "error": "agent slug 'nope' not found"}
        ),
    )
    out = ss.spawn_session_for_workflow(None, _payload(resolveAgentSlug="nope"))
    assert out["cancelled"] is True
    assert out["refusalKind"] == "agent_ref_unresolved"


def test_old_bff_skew_missing_echo_refuses_dispatch(monkeypatch):
    """An old BFF ignores resolveAgentSlug and provisions the DEFAULT runtime.
    The missing resolvedAgentSlug echo must refuse the dispatch."""
    monkeypatch.setattr(
        ss.requests,
        "post",
        lambda *a, **k: FakeResponse(
            200, {"sessionId": "s1", "agentId": "a1", "childInput": {"x": 1}}
        ),
    )
    out = ss.spawn_session_for_workflow(None, _payload(resolveAgentSlug="reviewer"))
    assert out["cancelled"] is True
    assert out["refusalKind"] == "agent_ref_unresolved"
    assert "not honored" in out["error"]


def test_echoed_slug_dispatches_normally(monkeypatch):
    monkeypatch.setattr(
        ss.requests,
        "post",
        lambda *a, **k: FakeResponse(
            200,
            {
                "sessionId": "s1",
                "agentId": "a1",
                "resolvedAgentSlug": "reviewer",
                "childInput": {"x": 1},
            },
        ),
    )
    out = ss.spawn_session_for_workflow(None, _payload(resolveAgentSlug="reviewer"))
    assert out.get("cancelled") is not True
    assert out["childInput"] == {"x": 1}


def test_without_slug_no_echo_needed(monkeypatch):
    monkeypatch.setattr(
        ss.requests,
        "post",
        lambda *a, **k: FakeResponse(
            200, {"sessionId": "s1", "agentId": "a1", "childInput": {}}
        ),
    )
    out = ss.spawn_session_for_workflow(None, _payload())
    assert out.get("cancelled") is not True
