from __future__ import annotations

import json
import urllib.request

import pytest

from src.tools._callable_agents_context import (
    clear_callable_agents_context,
    set_callable_agents_context,
)
from src.tools.call_agent import tool as call_agent_module


class _Response:
    status = 202

    def __init__(self, body: dict) -> None:
        self._body = json.dumps(body).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return self._body


@pytest.fixture(autouse=True)
def _clear_peer_context():
    clear_callable_agents_context()
    yield
    clear_callable_agents_context()


def test_http_202_peer_spawn_is_reported_as_explicitly_pending(monkeypatch):
    captured: dict[str, object] = {}

    def fake_urlopen(req: urllib.request.Request, timeout: int):
        captured["url"] = req.full_url
        captured["headers"] = dict(req.header_items())
        captured["body"] = json.loads(req.data)
        captured["timeout"] = timeout
        return _Response(
            {
                "sessionId": "ca-existing-child",
                "reused": True,
                "pending": True,
            }
        )

    monkeypatch.setenv("INTERNAL_API_TOKEN", "internal-token")
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    set_callable_agents_context(
        callable_agents=[
            {
                "slug": "researcher",
                "agentId": "agent-researcher",
                "appId": "agent-runtime-researcher",
                "team": "analysis-team",
                "registryKey": "researcher-v1",
            }
        ],
        registry_team="analysis-team",
        parent_instance_id="parent-runtime-instance",
        parent_session_id="parent-session",
        workflow_mcp_session_token="signed-session-token",
    )

    result = json.loads(call_agent_module.call_agent("researcher", "Investigate"))

    assert result == {
        "status": "pending",
        "peer": "researcher",
        "peer_app_id": "agent-runtime-researcher",
        "child_session_id": "ca-existing-child",
        "dapr_instance_id": None,
        "registry_team": "analysis-team",
        "registry_key": "researcher-v1",
        "reused": True,
        "pending": True,
        "hint": (
            "Child session is visible in the workspace sessions list as "
            "id=ca-existing-child. Use ReadSessionEvents with "
            "session_id='ca-existing-child' to poll the peer's progress and "
            "retrieve its final answer."
        ),
    }
    assert captured["url"] == (
        "http://localhost:3500/v1.0/invoke/workflow-builder/method/"
        "api/internal/sessions/spawn-peer"
    )
    assert captured["headers"] == {
        "Content-type": "application/json",
        "X-internal-token": "internal-token",
        "X-wfb-session-id": "parent-session",
        "X-wfb-session-token": "signed-session-token",
    }
    assert captured["body"]["parentSessionId"] == "parent-session"
    assert captured["body"]["peerAgentId"] == "agent-researcher"
    assert captured["timeout"] == 15
