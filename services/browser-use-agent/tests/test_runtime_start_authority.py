from __future__ import annotations

import io
import json
import urllib.error
import urllib.request
from datetime import timedelta
from pathlib import Path

import pytest

import src.agent as agent_module
import src.runtime_start_authority as activity_module
from src.adapters.workflow_builder_runtime_start_authority import (
    WorkflowBuilderRuntimeStartAuthorityAdapter,
)
from src.agent import BrowserUseDurableAgent
from src.ports.runtime_start_authority import (
    RuntimeStartAuthorityDecision,
    RuntimeStartAuthorityRequest,
)
from src.runtime_start_authority import authorize_session_runtime_start


class _FakeAuthorityPort:
    def __init__(self, decision: RuntimeStartAuthorityDecision) -> None:
        self.decision = decision
        self.requests: list[RuntimeStartAuthorityRequest] = []

    def authorize(
        self, request: RuntimeStartAuthorityRequest
    ) -> RuntimeStartAuthorityDecision:
        self.requests.append(request)
        return self.decision


class _Response:
    def __init__(self, body: dict) -> None:
        self._body = json.dumps(body).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return self._body


class _FakeContext:
    instance_id = "runtime-generation-1"
    is_replaying = False

    def __init__(self) -> None:
        self.activities: list[tuple[object, dict]] = []
        self.timers: list[timedelta] = []
        self.children: list[tuple[object, dict, str]] = []

    def call_activity(self, activity, *, input=None):
        self.activities.append((activity, input))
        return ("activity", activity, input)

    def create_timer(self, delay):
        self.timers.append(delay)
        return ("timer", delay)

    def call_child_workflow(self, workflow, *, input, instance_id):
        self.children.append((workflow, input, instance_id))
        return ("child", workflow, input, instance_id)


def _request() -> RuntimeStartAuthorityRequest:
    return RuntimeStartAuthorityRequest(
        session_id="session/1",
        session_token="signed-token",
        runtime_app_id="browser-runtime-generation",
        runtime_instance_id="runtime-generation-1",
    )


def _adapter() -> WorkflowBuilderRuntimeStartAuthorityAdapter:
    return WorkflowBuilderRuntimeStartAuthorityAdapter(
        internal_token="internal-token",
        workflow_builder_app_id="workflow-builder",
        dapr_http_port="3500",
    )


def _message() -> dict:
    return {
        "sessionId": "session-1",
        "runtimeAppId": "browser-runtime-generation",
        "workflowMcpSessionToken": "signed-token",
        "requiresStartAuthority": True,
        "autoTerminateAfterEndTurn": True,
        "initialEvents": [
            {
                "type": "user.message",
                "content": [{"type": "text", "text": "open example.com"}],
            }
        ],
    }


def _workflow(ctx: _FakeContext):
    agent = object.__new__(BrowserUseDurableAgent)
    return agent.session_workflow(ctx, _message())


def test_start_authority_pending_schedule_covers_recovery_interval():
    schedule = agent_module._START_AUTHORITY_PENDING_DELAYS_SECONDS

    assert schedule[:6] == (1, 2, 4, 8, 15, 30)
    assert sum(schedule) >= 15 * 60


def test_activity_calls_authority_port_with_exact_generation(monkeypatch):
    port = _FakeAuthorityPort(RuntimeStartAuthorityDecision(authorized=True))
    monkeypatch.setattr(activity_module, "runtime_start_authority_port", lambda: port)

    result = authorize_session_runtime_start(
        object(),
        {
            "sessionId": " session/1 ",
            "workflowMcpSessionToken": " signed-token ",
            "runtimeAppId": " browser-runtime-generation ",
            "runtimeInstanceId": " runtime-generation-1 ",
        },
    )

    assert result == {"authorized": True}
    assert port.requests == [_request()]


def test_adapter_only_retries_explicit_publication_pending_codes(monkeypatch):
    body = json.dumps(
        {
            "code": "runtime_superseded",
            "retryable": True,
            "message": "not authorized",
        }
    ).encode("utf-8")

    def fake_urlopen(req, timeout):
        raise urllib.error.HTTPError(
            req.full_url,
            409,
            "Conflict",
            hdrs=None,
            fp=io.BytesIO(body),
        )

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    assert _adapter().authorize(_request()) == RuntimeStartAuthorityDecision(
        authorized=False,
        status=409,
        code="runtime_superseded",
        retryable=False,
        reason="not authorized",
    )


def test_denial_finishes_before_browser_events_or_work(monkeypatch):
    published: list[tuple] = []
    monkeypatch.setattr(
        agent_module,
        "publish_session_event",
        lambda *args, **kwargs: published.append((args, kwargs)),
    )
    ctx = _FakeContext()
    workflow = _workflow(ctx)

    assert next(workflow)[0:2] == ("activity", authorize_session_runtime_start)
    with pytest.raises(StopIteration) as stopped:
        workflow.send(
            {
                "authorized": False,
                "status": 409,
                "code": "runtime_superseded",
                "retryable": False,
            }
        )

    assert stopped.value.value["status"] == "cancelled"
    assert published == []
    assert ctx.children == []


def test_publication_pending_retries_before_browser_work(monkeypatch):
    published: list[str] = []
    monkeypatch.setattr(
        agent_module,
        "publish_session_event",
        lambda _session_id, event_type, _data: published.append(event_type),
    )
    ctx = _FakeContext()
    workflow = _workflow(ctx)

    assert next(workflow)[0:2] == ("activity", authorize_session_runtime_start)
    timer = workflow.send(
        {
            "authorized": False,
            "status": 409,
            "code": "runtime_unpublished",
            "retryable": True,
        }
    )
    assert timer == ("timer", timedelta(seconds=1))
    assert published == []
    assert workflow.send(None)[0:2] == ("activity", authorize_session_runtime_start)

    child = workflow.send({"authorized": True})
    assert child[0] == "child"
    assert published[:2] == ["session.status_rescheduled", "session.status_running"]


def test_agent_registers_authority_activity():
    source = (Path(__file__).parents[1] / "src/agent.py").read_text()
    assert (
        "runtime.register_activity(\n            authorize_session_runtime_start,"
        in source
    )
    assert "name=AUTHORIZE_SESSION_RUNTIME_START_ACTIVITY" in source
