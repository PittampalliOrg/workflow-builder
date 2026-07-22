from __future__ import annotations

from datetime import timedelta

import pytest

import src.session as session_module
from src.runtime_start_authority import authorize_session_runtime_start
from src.session import session_workflow


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


def _message() -> dict:
    return {
        "sessionId": "session-1",
        "runtimeAppId": "agent-runtime-pool-coding",
        "workflowMcpSessionToken": "signed-token",
        "requiresStartAuthority": True,
        "autoTerminateAfterEndTurn": True,
        "initialEvents": [
            {
                "type": "user.message",
                "content": [{"type": "text", "text": "do work"}],
            }
        ],
    }


def test_start_authority_pending_schedule_covers_recovery_interval():
    schedule = session_module._START_AUTHORITY_PENDING_DELAYS_SECONDS

    assert schedule[:6] == (1, 2, 4, 8, 15, 30)
    assert sum(schedule) >= 15 * 60


def test_denial_finishes_before_status_events_or_agent_work(monkeypatch):
    published: list[tuple] = []
    monkeypatch.setattr(
        session_module,
        "publish_session_event",
        lambda *args, **kwargs: published.append((args, kwargs)),
    )
    ctx = _FakeContext()
    workflow = session_workflow(ctx, _message())

    first = next(workflow)
    assert first[0:2] == ("activity", authorize_session_runtime_start)
    with pytest.raises(StopIteration) as stopped:
        workflow.send(
            {
                "authorized": False,
                "status": 409,
                "code": "runtime_superseded",
                "retryable": False,
            }
        )

    assert stopped.value.value == {
        "success": False,
        "cancelled": True,
        "status": "cancelled",
        "content": "",
        "sessionId": "session-1",
        "error": "session start was not authorized",
    }
    assert published == []
    assert ctx.children == []


def test_publication_pending_is_durably_retried_before_child_start(monkeypatch):
    published: list[str] = []
    monkeypatch.setattr(
        session_module,
        "publish_session_event",
        lambda _session_id, event_type, _data: published.append(event_type),
    )
    ctx = _FakeContext()
    workflow = session_workflow(ctx, _message())

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
    assert workflow.send(None)[0:2] == (
        "activity",
        authorize_session_runtime_start,
    )

    child = workflow.send({"authorized": True})
    assert child[0] == "child"
    assert published[:2] == ["session.status_rescheduled", "session.status_running"]
    assert ctx.activities == [
        (
            authorize_session_runtime_start,
            {
                "sessionId": "session-1",
                "workflowMcpSessionToken": "signed-token",
                "runtimeAppId": "agent-runtime-pool-coding",
                "runtimeInstanceId": "runtime-generation-1",
            },
        ),
        (
            authorize_session_runtime_start,
            {
                "sessionId": "session-1",
                "workflowMcpSessionToken": "signed-token",
                "runtimeAppId": "agent-runtime-pool-coding",
                "runtimeInstanceId": "runtime-generation-1",
            },
        ),
    ]
    assert ctx.timers == [timedelta(seconds=1)]
    assert len(ctx.children) == 1
