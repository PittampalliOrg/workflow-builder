"""Script-led team primitives: dispatch routing, journal semantics, join
predicates, and the team_ops 4xx-vs-5xx error classification."""

from __future__ import annotations

from typing import Any

import pytest

import activities.team_ops as team_ops
from activities.script_call_journal import record_script_call_result
from workflows.script_agent_dispatch import start_team_call, TEAM_JOIN_WORKFLOW_NAME
from workflows.team_join_workflow import _predicate_satisfied


# ── start_team_call routing ───────────────────────────────────────────────


class RoutingCtx:
    instance_id = "dsw-x-exec-e1"

    def __init__(self) -> None:
        self.child_calls: list[dict[str, Any]] = []
        self.activity_calls: list[dict[str, Any]] = []

    def call_child_workflow(self, name, *, input=None, instance_id=None):
        self.child_calls.append({"name": name, "input": input, "instance_id": instance_id})
        return object()  # opaque un-awaited Task

    def call_activity(self, fn, *, input=None, retry_policy=None):
        self.activity_calls.append(
            {
                "fn": getattr(fn, "__name__", str(fn)),
                "input": input,
                "retry_policy": retry_policy,
            }
        )
        return object()


def test_join_dispatches_the_join_child_workflow():
    ctx = RoutingCtx()
    task = start_team_call(
        ctx,
        call_id="abc123",
        spec={"teamOp": "join", "args": {"until": "all-idle", "timeoutMinutes": 5}},
        exec_id="e1",
        meta={"name": "demo"},
        otel=None,
    )
    assert task is not None and not isinstance(task, dict)
    assert len(ctx.child_calls) == 1
    call = ctx.child_calls[0]
    assert call["name"] == TEAM_JOIN_WORKFLOW_NAME
    assert call["input"]["until"] == "all-idle"
    assert call["input"]["executionId"] == "e1"
    assert "__durable-script__" in call["instance_id"]


@pytest.mark.parametrize("op", ["spawn", "task", "send", "broadcast", "status", "shutdown"])
def test_simple_ops_dispatch_as_activity_tasks(op):
    ctx = RoutingCtx()
    task = start_team_call(
        ctx,
        call_id="abc123",
        spec={"teamOp": op, "args": {"name": "r"}},
        exec_id="e1",
        meta={"name": "demo"},
        otel=None,
    )
    assert task is not None and not isinstance(task, dict)
    assert len(ctx.activity_calls) == 1
    call = ctx.activity_calls[0]
    assert call["fn"] == "execute_team_op"
    assert call["input"]["op"] == op
    assert call["input"]["teamName"] == "demo"
    # Transport/5xx raises out of execute_team_op MUST be retried — one BFF
    # blip must not throw into the script (dev regression 2026-07-10).
    assert call["retry_policy"] is not None


def test_unknown_op_is_a_dispatch_error():
    ctx = RoutingCtx()
    task = start_team_call(
        ctx,
        call_id="abc123",
        spec={"teamOp": "explode", "args": {}},
        exec_id="e1",
        meta=None,
        otel=None,
    )
    assert isinstance(task, dict)
    assert "unknown team op" in task["dispatchError"]


# ── journal team branch ───────────────────────────────────────────────────


def _journal(monkeypatch, spec: dict, raw: dict) -> tuple[dict, list[dict]]:
    persisted: list[dict] = []
    import activities.script_call_journal as j

    class FakeClient:
        def put_script_call(self, execution_id, call_id, row):
            persisted.append({"executionId": execution_id, "callId": call_id, **row})

    monkeypatch.setattr(j, "script_journal_client", FakeClient())
    out = record_script_call_result(
        None,
        {"executionId": "e1", "callId": "c1", "seq": 1, "spec": spec, "raw": raw},
    )
    return out, persisted


def test_journal_team_success_is_done_with_result_passthrough(monkeypatch):
    out, rows = _journal(
        monkeypatch,
        {"kind": "team", "teamOp": "spawn"},
        {"success": True, "result": {"ok": True, "name": "r", "sessionId": "s1"}},
    )
    assert out["status"] == "done"
    assert rows[0]["status"] == "done"
    assert rows[0]["result"] == {"ok": True, "name": "r", "sessionId": "s1"}


def test_journal_team_failure_is_error_with_throwable_message(monkeypatch):
    out, rows = _journal(
        monkeypatch,
        {"kind": "team", "teamOp": "spawn"},
        {"success": False, "error": "no agent 'nope' in this project"},
    )
    assert out["status"] == "error"
    assert out["errorCode"] == "team_op_error"
    assert rows[0]["result"] == {"message": "no agent 'nope' in this project"}


def test_journal_team_skip_still_wins(monkeypatch):
    out, _ = _journal(monkeypatch, {"kind": "team", "teamOp": "send"}, {"skipped": True})
    assert out["status"] == "skipped"


# ── join predicates ───────────────────────────────────────────────────────


def test_tasks_complete_predicate():
    assert not _predicate_satisfied("tasks-complete", {"tasks": [], "members": []})
    assert not _predicate_satisfied(
        "tasks-complete",
        {"tasks": [{"status": "completed"}, {"status": "in_progress"}]},
    )
    assert _predicate_satisfied(
        "tasks-complete", {"tasks": [{"status": "completed"}, {"status": "completed"}]}
    )


def test_all_idle_predicate():
    lead = {"role": "lead", "status": "working"}
    assert not _predicate_satisfied("all-idle", {"members": [lead]})  # no workers yet
    assert not _predicate_satisfied(
        "all-idle", {"members": [lead, {"role": "member", "status": "working"}]}
    )
    assert _predicate_satisfied(
        "all-idle",
        {
            "members": [
                lead,  # the lead's own status never blocks quiescence
                {"role": "member", "status": "idle"},
                {"role": "member", "status": "suspended"},
                {"role": "member", "status": "shutdown"},
            ]
        },
    )


# ── team_ops error classification ─────────────────────────────────────────


class FakeResponse:
    def __init__(self, status_code: int, body: Any):
        self.status_code = status_code
        self._body = body
        self.text = str(body)

    def json(self):
        if isinstance(self._body, (dict, list)):
            return self._body
        raise ValueError("not json")


def test_execute_team_op_4xx_is_deterministic_failure(monkeypatch):
    calls: list[str] = []

    def fake_request(method, url, **kwargs):
        calls.append(url)
        if url.endswith("/ensure-script-team"):
            return FakeResponse(200, {"teamId": "team-e1", "leadSessionId": "lead-e1"})
        return FakeResponse(404, {"message": "no agent 'nope' in this project"})

    monkeypatch.setenv("INTERNAL_API_TOKEN", "t")
    monkeypatch.setenv("WORKFLOW_DATA_API_TRANSPORT", "direct")
    monkeypatch.setattr(team_ops.requests, "request", fake_request)

    out = team_ops.execute_team_op(
        None,
        {"executionId": "e1", "op": "spawn", "args": {"agent": "nope", "name": "r", "prompt": "x"}},
    )
    assert out == {"success": False, "error": "no agent 'nope' in this project"}


def test_execute_team_op_5xx_raises_for_activity_retry(monkeypatch):
    def fake_request(method, url, **kwargs):
        return FakeResponse(500, "boom")

    monkeypatch.setenv("INTERNAL_API_TOKEN", "t")
    monkeypatch.setenv("WORKFLOW_DATA_API_TRANSPORT", "direct")
    monkeypatch.setattr(team_ops.requests, "request", fake_request)

    with pytest.raises(team_ops.TeamOpsApiError):
        team_ops.execute_team_op(None, {"executionId": "e1", "op": "status", "args": {}})


def test_execute_team_op_success_carries_team_identity(monkeypatch):
    def fake_request(method, url, **kwargs):
        if url.endswith("/ensure-script-team"):
            return FakeResponse(200, {"teamId": "team-e1", "leadSessionId": "lead-e1"})
        return FakeResponse(200, {"ok": True, "task": {"id": "t1"}})

    monkeypatch.setenv("INTERNAL_API_TOKEN", "t")
    monkeypatch.setenv("WORKFLOW_DATA_API_TRANSPORT", "direct")
    monkeypatch.setattr(team_ops.requests, "request", fake_request)

    out = team_ops.execute_team_op(
        None, {"executionId": "e1", "op": "task", "args": {"title": "do it"}}
    )
    assert out["success"] is True
    assert out["teamId"] == "team-e1"
    assert out["result"] == {"ok": True, "task": {"id": "t1"}}


# ── Stage-1 UI data: rail labels + spawn sessionId backfill ───────────────


def test_team_call_label_all_ops():
    from workflows.dynamic_script_workflow import _team_call_label

    assert _team_call_label("spawn", {"name": "researcher"}) == "spawn researcher"
    assert _team_call_label("spawn", {"agent": "glm"}) == "spawn glm"
    assert _team_call_label("task", {"title": "A very long title that keeps going"}) == 'task "A very long title that k"'
    assert _team_call_label("task", {}) == "task"
    assert _team_call_label("send", {"to": "critic"}) == "send → critic"
    assert _team_call_label("broadcast", {}) == "broadcast"
    assert _team_call_label("join", {"until": "all-idle"}) == "join (all-idle)"
    assert _team_call_label("join", {}) == "join (tasks-complete)"
    assert _team_call_label("shutdown", {}) == "shutdown all"
    assert _team_call_label("shutdown", {"name": "critic"}) == "shutdown critic"
    assert _team_call_label("status", {}) == "status"


def test_journal_spawn_backfills_session_id(monkeypatch):
    out, rows = _journal(
        monkeypatch,
        {"kind": "team", "teamOp": "spawn"},
        {"success": True, "result": {"ok": True, "name": "r", "sessionId": "tm-team-x-r"}},
    )
    assert out["status"] == "done"
    assert rows[0]["sessionId"] == "tm-team-x-r"


def test_journal_send_leaves_session_id_none(monkeypatch):
    out, rows = _journal(
        monkeypatch,
        {"kind": "team", "teamOp": "send"},
        {"success": True, "result": {"ok": True, "to": "critic"}},
    )
    assert out["status"] == "done"
    assert rows[0]["sessionId"] is None


def test_journal_spawn_without_session_id_is_safe(monkeypatch):
    out, rows = _journal(
        monkeypatch,
        {"kind": "team", "teamOp": "spawn"},
        {"success": True, "result": {"ok": True}},
    )
    assert out["status"] == "done"
    assert rows[0]["sessionId"] is None
