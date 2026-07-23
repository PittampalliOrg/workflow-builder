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
        self.continuations: list[tuple[dict, bool]] = []

    def call_activity(self, activity, *, input=None):
        self.activities.append((activity, input))
        return ("activity", activity, input)

    def create_timer(self, delay):
        self.timers.append(delay)
        return ("timer", delay)

    def call_child_workflow(self, workflow, *, input, instance_id):
        self.children.append((workflow, input, instance_id))
        return ("child", workflow, input, instance_id)

    def wait_for_external_event(self, name):
        return ("external", name)

    def continue_as_new(self, new_input, *, save_events=False):
        self.continuations.append((new_input, save_events))


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


def test_agent_iteration_override_is_hard_capped_per_turn():
    assert session_module._resolve_max_iterations({"maxTurns": 999}) == 80
    assert session_module._resolve_max_iterations({"maxIterations": 999}) == 80
    assert session_module._resolve_max_iterations({"maxTurns": 7}) == 7


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
        "startAuthority": {
            "status": 409,
            "code": "runtime_superseded",
            "retryable": False,
        },
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
    assert child[2]["historyRef"] is None
    assert "history" not in child[2]


def test_one_shot_session_forwards_and_returns_only_history_reference(monkeypatch):
    monkeypatch.setattr(session_module, "publish_session_event", lambda *_args: None)
    message = _message()
    message["historyRef"] = "history+sha256://" + "1" * 64
    ctx = _FakeContext()
    workflow = session_workflow(ctx, message)

    assert next(workflow)[0:2] == ("activity", authorize_session_runtime_start)
    child = workflow.send({"authorized": True})
    assert child[2]["historyRef"] == message["historyRef"]
    assert "history" not in child[2]

    next_ref = "history+sha256://" + "2" * 64
    with pytest.raises(StopIteration) as stopped:
        workflow.send(
            {
                "success": True,
                "content": "done",
                "historyRef": next_ref,
                "messages": [{"kind": "legacy-inline-history"}],
            }
        )

    assert stopped.value.value["historyRef"] == next_ref
    assert "messages" not in stopped.value.value


def test_non_one_shot_session_continues_as_new_with_returned_history_reference(
    monkeypatch,
):
    captured_inputs: list[dict] = []

    def fake_agent_workflow(_ctx, child_input):
        captured_inputs.append(child_input)
        result = yield ("agent-turn", len(captured_inputs))
        return result

    monkeypatch.setattr(session_module, "agent_workflow", fake_agent_workflow)
    monkeypatch.setattr(session_module, "publish_session_event", lambda *_args: None)
    initial_ref = "history+sha256://" + "a" * 64
    next_ref = "history+sha256://" + "b" * 64
    message = {
        "sessionId": "session-1",
        "historyRef": initial_ref,
        "initialEvents": [
            {
                "type": "user.message",
                "content": [{"type": "text", "text": "first"}],
            }
        ],
    }
    ctx = _FakeContext()
    workflow = session_workflow(ctx, message)

    assert next(workflow) == ("agent-turn", 1)
    assert captured_inputs[0]["historyRef"] == initial_ref
    assert "history" not in captured_inputs[0]
    with pytest.raises(StopIteration):
        workflow.send(
            {
                "content": "first done",
                "historyRef": next_ref,
                "messages": [{"kind": "must-not-be-reused"}],
            }
        )

    assert len(ctx.continuations) == 1
    continuation, save_events = ctx.continuations[0]
    assert save_events is True
    assert continuation["historyRef"] == next_ref
    assert "history" not in continuation
    assert continuation["initialEvents"] == []
    assert continuation["sessionWorkflowState"] == {
        "turnCounter": 1,
        "configRevision": 1,
        "controlOverrideFields": [],
        "continuationCount": 1,
        "lastContinueAsNewReason": "turn_complete",
        "teamMailboxBatchIds": [],
        "teamMailboxEventIds": [],
    }

    resumed_ctx = _FakeContext()
    resumed = session_workflow(resumed_ctx, continuation)
    assert next(resumed) == ("external", "session.user_events")
    second = resumed.send(
        {
            "events": [
                {
                    "type": "user.message",
                    "content": [{"type": "text", "text": "second"}],
                }
            ]
        }
    )
    assert second == ("agent-turn", 2)
    assert captured_inputs[1]["historyRef"] == next_ref
    assert "history" not in captured_inputs[1]


def test_continue_as_new_preserves_config_overrides_and_mailbox_receipts(monkeypatch):
    captured_inputs: list[dict] = []

    def fake_agent_workflow(_ctx, child_input):
        captured_inputs.append(child_input)
        result = yield ("agent-turn", 1)
        return result

    monkeypatch.setattr(session_module, "agent_workflow", fake_agent_workflow)
    monkeypatch.setattr(session_module, "publish_session_event", lambda *_args: None)
    event = {
        "type": "user.message",
        "content": [{"type": "text", "text": "use the update"}],
    }
    message = {
        "sessionId": "session-1",
        "agentConfig": {"modelSpec": "old", "maxTurns": 2},
        "initialEvents": [
            {
                "type": "session.control.update_agent_config",
                "patch": {"modelSpec": "kimi/kimi-k3", "maxTurns": 4},
            },
            event,
        ],
        "sessionWorkflowState": {
            "turnCounter": 3,
            "configRevision": 2,
            "continuationCount": 5,
            "controlOverrideFields": ["permissionMode"],
            "teamMailboxBatchIds": ["batch-1"],
            "teamMailboxEventIds": ["event-1"],
        },
    }
    ctx = _FakeContext()
    workflow = session_workflow(ctx, message)

    assert next(workflow) == ("agent-turn", 1)
    assert captured_inputs[0]["context"]["agentConfig"]["modelSpec"] == "kimi/kimi-k3"
    with pytest.raises(StopIteration):
        workflow.send({"content": "done", "historyRef": "history+sha256://" + "d" * 64})

    continuation, save_events = ctx.continuations[0]
    assert save_events is True
    assert continuation["agentConfig"]["modelSpec"] == "kimi/kimi-k3"
    assert continuation["agentConfig"]["maxTurns"] == 4
    assert continuation["sessionWorkflowState"] == {
        "turnCounter": 4,
        "configRevision": 3,
        "controlOverrideFields": ["maxTurns", "modelSpec", "permissionMode"],
        "continuationCount": 6,
        "lastContinueAsNewReason": "turn_complete",
        "teamMailboxBatchIds": ["batch-1"],
        "teamMailboxEventIds": ["event-1"],
    }


def test_one_shot_session_ignores_non_string_returned_history_reference(monkeypatch):
    monkeypatch.setattr(session_module, "publish_session_event", lambda *_args: None)
    message = _message()
    message["historyRef"] = "history+sha256://" + "c" * 64
    ctx = _FakeContext()
    workflow = session_workflow(ctx, message)

    next(workflow)
    workflow.send({"authorized": True})
    with pytest.raises(StopIteration) as stopped:
        workflow.send(
            {
                "success": True,
                "historyRef": {"not": "a reference"},
                "messages": [{"kind": "must-not-be-reused"}],
            }
        )

    assert stopped.value.value["historyRef"] == message["historyRef"]
    assert "messages" not in stopped.value.value


def test_one_shot_session_clears_explicitly_invalid_history_reference(monkeypatch):
    monkeypatch.setattr(session_module, "publish_session_event", lambda *_args: None)
    message = _message()
    message["historyRef"] = "history+sha256://" + "e" * 64
    ctx = _FakeContext()
    workflow = session_workflow(ctx, message)

    next(workflow)
    workflow.send({"authorized": True})
    with pytest.raises(StopIteration) as stopped:
        workflow.send(
            {
                "success": False,
                "historyRef": message["historyRef"],
                "historyRefInvalid": True,
                "messages": [{"kind": "must-not-be-reused"}],
            }
        )

    assert stopped.value.value["historyRefInvalid"] is True
    assert "historyRef" not in stopped.value.value
    assert "messages" not in stopped.value.value


def test_continue_as_new_clears_explicitly_invalid_history_reference(monkeypatch):
    def fake_agent_workflow(_ctx, _child_input):
        result = yield ("agent-turn", 1)
        return result

    monkeypatch.setattr(session_module, "agent_workflow", fake_agent_workflow)
    monkeypatch.setattr(session_module, "publish_session_event", lambda *_args: None)
    message = {
        "sessionId": "session-1",
        "historyRef": "history+sha256://" + "f" * 64,
        "initialEvents": [
            {
                "type": "user.message",
                "content": [{"type": "text", "text": "continue"}],
            }
        ],
    }
    ctx = _FakeContext()
    workflow = session_workflow(ctx, message)

    assert next(workflow) == ("agent-turn", 1)
    with pytest.raises(StopIteration):
        workflow.send(
            {
                "historyRef": message["historyRef"],
                "historyRefInvalid": True,
            }
        )

    continuation, save_events = ctx.continuations[0]
    assert save_events is True
    assert "historyRef" not in continuation
    assert "history" not in continuation
