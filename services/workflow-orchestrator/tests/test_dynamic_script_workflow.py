"""Pure-pytest tests for the dynamic-script re-execution pump.

Drives the real ``dynamic_script_workflow`` generator with a ``FakeCtx`` whose
``call_activity`` returns scripted results and whose ``call_child_workflow`` /
``wait_for_external_event`` return REAL ``CompletableTask`` instances from the
vendored durabletask SDK — so ``when_any`` semantics (identity winner, drain-all,
replay ordering) are exercised for real, not faked.

Style follows ``tests/test_cel_loop.py`` (no Dapr runtime, no network — the pump
calls ``ctx.call_activity(fn, ...)`` but ``FakeCtx`` intercepts by ``fn.__name__``
and never executes the activity body).
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import pytest

# Real vendored durabletask tasks (identity winner + drain-all semantics).
from dapr.ext.workflow._durabletask.task import (
    CompletableTask,
    WhenAnyTask,
)

from workflows.dynamic_script_workflow import dynamic_script_workflow
from workflows.script_agent_dispatch import script_child_instance_id

CONTRACT_PATH = (
    Path(__file__).resolve().parents[2]
    / "shared"
    / "contracts"
    / "script-evaluator-evaluate.contract.json"
)
CALLID_VECTORS_PATH = (
    Path(__file__).resolve().parents[2]
    / "shared"
    / "contracts"
    / "script-evaluator-callid-vectors.json"
)


# ---------------------------------------------------------------------------
# Contract-shaped evaluator responses
# ---------------------------------------------------------------------------
def plan_need(tasks, *, new_logs=None, log_count=0, current_phase=None, declared=None):
    return {
        "status": "need",
        "tasks": list(tasks),
        "returnValue": None,
        "error": None,
        "phases": {"declared": declared or [], "current": current_phase},
        "newLogs": new_logs or [],
        "logCount": log_count,
        "counts": {"totalCallsSeen": len(tasks)},
        "evaluatorVersion": "1.0.0",
    }


def plan_done(return_value, *, log_count=0, current_phase=None, declared=None):
    return {
        "status": "done",
        "tasks": [],
        "returnValue": return_value,
        "error": None,
        "phases": {"declared": declared or [], "current": current_phase},
        "newLogs": [],
        "logCount": log_count,
        "counts": {"totalCallsSeen": 0},
        "evaluatorVersion": "1.0.0",
    }


def plan_script_error(message):
    return {
        "status": "script_error",
        "tasks": [],
        "returnValue": None,
        "error": {"message": message, "stack": None},
        "phases": {"declared": [], "current": None},
        "newLogs": [],
        "logCount": 0,
        "counts": {"totalCallsSeen": 0},
        "evaluatorVersion": "1.0.0",
    }


def agent_task(call_id, *, prompt="do", label=None, schema=None, phase=None):
    return {
        "callId": call_id,
        "kind": "agent",
        "prompt": prompt,
        "opts": {
            "label": label,
            "phase": phase,
            "schema": schema,
            "model": None,
            "effort": None,
            "isolation": None,
            "agentType": None,
        },
        "baseHash": call_id.split("_")[0] if "_" in call_id else call_id,
        "occurrence": 0,
    }


def workflow_task(call_id, workflow_ref, args=None):
    return {
        "callId": call_id,
        "kind": "workflow",
        "prompt": "",
        "opts": {"label": None, "phase": None, "schema": None},
        "workflowRef": workflow_ref,
        "args": args or {},
        "baseHash": call_id.split("_")[0] if "_" in call_id else call_id,
        "occurrence": 0,
    }


def action_task(call_id, slug, args=None, *, label=None, action_opts=None):
    return {
        "callId": call_id,
        "kind": "action",
        "prompt": "",
        "opts": {
            "label": label,
            "phase": None,
            "schema": None,
            "model": None,
            "effort": None,
            "isolation": None,
            "agentType": None,
        },
        "baseHash": call_id.split("_")[0] if "_" in call_id else call_id,
        "occurrence": 0,
        "actionSlug": slug,
        "actionOpts": action_opts
        or {"connection": None, "timeoutMs": None, "allowFailure": False, "idempotent": False},
        **({} if args is None else {"args": args}),
    }


def sleep_task(call_id, seconds):
    return {
        "callId": call_id,
        "kind": "sleep",
        "prompt": "",
        "opts": {"label": None, "phase": None, "schema": None},
        "baseHash": call_id.split("_")[0] if "_" in call_id else call_id,
        "occurrence": 0,
        "seconds": seconds,
    }


def event_task(call_id, name="approval"):
    return {
        "callId": call_id,
        "kind": "event",
        "prompt": "",
        "opts": {"label": None, "phase": None, "schema": None},
        "baseHash": call_id.split("_")[0] if "_" in call_id else call_id,
        "occurrence": 0,
        "eventName": name,
        "eventOpts": {"timeoutMinutes": None, "message": None},
    }


def make_evaluator(
    tasks,
    return_value,
    *,
    logs=None,
    honor_budget=False,
    error_on_exhaust=False,
):
    """Stateless evaluator mock mirroring the SSOT semantics.

    Returns every UNRESOLVED task each round (so the pump's dedup is exercised),
    ``done`` once all tasks are resolved, and — when ``honor_budget`` — a terminal
    outcome as soon as ``budget.exhausted``/``lifetimeExceeded`` is observed.
    """
    logs = logs or []

    def ev(input_data):
        known = set(input_data.get("knownCallIds") or [])
        budget = input_data.get("budget") or {}
        if honor_budget and (budget.get("exhausted") or budget.get("lifetimeExceeded")):
            if error_on_exhaust:
                return plan_script_error("budget exhausted")
            return plan_done(return_value)
        remaining = [t for t in tasks if t["callId"] not in known]
        if not remaining:
            return plan_done(return_value)
        seen = int(input_data.get("seenLogCount") or 0)
        new_logs = logs[seen:] if logs else []
        return plan_need(remaining, new_logs=new_logs, log_count=len(logs))

    return ev


def make_spawn_sequence(*values):
    """Successive spawn_session_for_workflow bodies (last one repeats) — models
    a per-session host progressing queued -> ready across P2 re-polls."""
    state = {"i": 0}

    def _next():
        value = values[min(state["i"], len(values) - 1)]
        state["i"] += 1
        return value

    return _next


# ---------------------------------------------------------------------------
# FakeCtx
# ---------------------------------------------------------------------------
class FakeCtx:
    def __init__(
        self,
        *,
        evaluator: Callable[[dict], dict],
        record_fn: Callable[[dict], dict] | None = None,
        usage_values: list[int] | None = None,
        spawn_result: Any = None,
        resolve_result: dict | None = None,
        instance_id: str = "dsw-test-exec-e1",
    ):
        self.instance_id = instance_id
        self.is_replaying = False
        # Deterministic fake workflow clock (concurrency plan P2): readiness
        # waits now live in workflow code as durable-timer polls keyed off
        # ctx.current_utc_datetime; the clock starts fixed and only advances
        # when a create_timer fires, so replay-determinism assertions hold.
        self._now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self._evaluator = evaluator
        self._record_fn = record_fn or (lambda inp: {"status": "done"})
        self._usage_values = list(usage_values or [])
        self._usage_i = 0
        self._spawn_result = spawn_result if spawn_result is not None else {
            "childInput": {"foo": "bar"},
            "agentAppId": "dapr-agent-py",
            "agentId": "ag1",
        }
        self._resolve_result = resolve_result or {
            "success": True,
            "script": "return 1",
            "scriptSha256": "abc",
            "meta": {"name": "child"},
        }

        self.action_log: list[tuple] = []
        self.custom_statuses: list[str] = []
        self.children: dict[str, CompletableTask] = {}
        self.child_inputs: dict[str, dict] = {}
        self.events: dict[str, list[CompletableTask]] = {}
        self.record_inputs: list[dict] = []
        self.dispatch_inputs: list[dict] = []
        self.prepare_inputs: list[dict] = []
        self.stop_inputs: list[dict] = []
        self.execute_action_inputs: list[dict] = []
        self.cli_workspace_inputs: list[dict] = []
        self.persist_workspace_inputs: list[dict] = []
        # Sequenced results: pop from the front while >1 remain (last repeats) —
        # lets the action-runner tests model BEGIN->pause->RESUME->done rounds.
        self.execute_action_results: list[dict] = [{"success": True, "data": {"ok": 1}}]
        self.pause_inputs: list[dict] = []

    # -- deterministic side effects captured for assertions ----------------
    @property
    def current_utc_datetime(self) -> datetime:
        return self._now

    def set_custom_status(self, status: str) -> None:
        self.custom_statuses.append(status)

    def wait_for_external_event(self, name: str, timeout=None) -> CompletableTask:
        task = CompletableTask()
        self.events.setdefault(name, []).append(task)
        self.action_log.append(("event", name))
        return task

    def call_activity(self, fn, *, input=None, retry_policy=None) -> CompletableTask:
        name = getattr(fn, "__name__", str(fn))
        inp = input if isinstance(input, dict) else {}
        # Log a stable key per activity for determinism assertions.
        self.action_log.append(("activity", name, self._log_key(name, inp)))
        result = self._activity_result(name, inp)
        task = CompletableTask()
        task.complete(result)
        return task

    def create_timer(self, fire_at) -> CompletableTask:
        # Durable timers: the usage-settle gate passes a timedelta; the P2
        # workflow-level readiness polls pass an absolute datetime derived from
        # ctx.current_utc_datetime. Both fire immediately in tests, but the
        # fake clock advances deterministically to the timer's fire time so
        # poll deadlines are exercised for real.
        if isinstance(fire_at, timedelta):
            fire_at = self._now + fire_at
        self.action_log.append(("timer", fire_at.isoformat()))
        self._now = fire_at
        task = CompletableTask()
        task.complete(None)
        return task

    def call_child_workflow(self, name, *, input=None, instance_id=None, **kwargs) -> CompletableTask:
        self.action_log.append(("child", name, instance_id))
        task = CompletableTask()
        self.children[instance_id] = task
        self.child_inputs[instance_id] = input if isinstance(input, dict) else {}
        return task

    # -- scripted results --------------------------------------------------
    def _activity_result(self, name: str, inp: dict) -> dict:
        if name == "evaluate_script":
            return self._evaluator(inp)
        if name == "aggregate_script_usage":
            if self._usage_i < len(self._usage_values):
                value = self._usage_values[self._usage_i]
                self._usage_i += 1
                return {"totalTokens": value}
            return {"totalTokens": 0}
        if name == "spawn_session_for_workflow":
            return self._spawn_result() if callable(self._spawn_result) else self._spawn_result
        if name == "resolve_script_workflow":
            return self._resolve_result
        if name == "prepare_script_call":
            self.prepare_inputs.append(inp)
            return self._prepare_result(inp)
        if name == "execute_action":
            self.execute_action_inputs.append(inp)
            if len(self.execute_action_results) > 1:
                return self.execute_action_results.pop(0)
            return self.execute_action_results[0]
        if name == "cli_workspace_command":
            self.cli_workspace_inputs.append(inp)
            return {
                "success": True,
                "data": {
                    "success": True,
                    "result": {"exitCode": 0, "stdout": "seeded", "stderr": ""},
                },
            }
        if name == "persist_workspace_session":
            self.persist_workspace_inputs.append(inp)
            return {"success": True}
        if name == "record_script_call_pause":
            self.pause_inputs.append(inp)
            return {"success": True}
        if name == "request_session_stop":
            self.stop_inputs.append(inp)
            return {"ok": True, "state": "stopping"}
        if name == "record_script_call_result":
            self.record_inputs.append(inp)
            return self._record_fn(inp)
        if name == "record_script_call_dispatch":
            self.dispatch_inputs.append(inp)
            return {"success": True}
        # append_script_logs / update_execution_node / track_agent_run_* / import
        return {"success": True}

    def _log_key(self, name: str, inp: dict) -> str:
        if name == "evaluate_script":
            return "known=" + ",".join(inp.get("knownCallIds") or [])
        if name in ("record_script_call_result", "record_script_call_dispatch"):
            return str(inp.get("callId"))
        if name in ("update_execution_node", "track_agent_run_scheduled"):
            return str(inp.get("nodeId") or inp.get("id"))
        if name == "track_agent_run_completed":
            return str(inp.get("id"))
        if name == "import_script_journal":
            return str(inp.get("fromExecutionId"))
        if name in ("prepare_script_call", "request_session_stop"):
            return str(inp.get("callId") or inp.get("sessionId"))
        return ""

    def _prepare_result(self, inp: dict) -> dict:
        cid = str(inp.get("callId") or "")
        spec = inp.get("spec") if isinstance(inp.get("spec"), dict) else {}
        child_instance_id = script_child_instance_id(
            str(inp.get("parentInstanceId") or self.instance_id),
            cid,
            int(spec.get("retries") or 0),
        )
        kind = spec.get("kind") or "agent"
        if kind == "workflow":
            if not self._resolve_result.get("success"):
                ref = spec.get("workflowRef")
                return {
                    "kind": "dispatchError",
                    "callId": cid,
                    "childInstanceId": child_instance_id,
                    "dispatchError": f"workflow() could not resolve {ref!r}: {self._resolve_result.get('error')}",
                }
            child_input = {
                "executionId": inp.get("executionId"),
                "script": self._resolve_result.get("script"),
                "scriptSha256": self._resolve_result.get("scriptSha256"),
                "meta": self._resolve_result.get("meta") or {},
                "budgetTotal": inp.get("budgetTotal"),
                "nested": True,
                "limits": inp.get("limits") or {},
                "defaults": inp.get("defaults") or {},
                "workflowId": inp.get("workflowId"),
                "userId": inp.get("userId"),
                "projectId": inp.get("projectId"),
                "_otel": inp.get("_otel") or {},
            }
            if "args" in spec:
                child_input["args"] = spec.get("args")
            return {
                "kind": "workflow",
                "callId": cid,
                "childInstanceId": child_instance_id,
                "childWorkflowName": "dynamic_script_workflow_v1",
                "childInput": child_input,
            }
        bridge = self._spawn_result() if callable(self._spawn_result) else self._spawn_result
        child_input = {
            **(bridge.get("childInput") if isinstance(bridge, dict) else {}),
            "workflowId": inp.get("workflowId"),
            "workflowExecutionId": inp.get("executionId"),
            "dbExecutionId": inp.get("executionId"),
            "nodeId": cid,
            "nodeName": spec.get("label") or cid[:8],
            "agentId": bridge.get("agentId") if isinstance(bridge, dict) else None,
            "agentAppId": (
                bridge.get("agentAppId") if isinstance(bridge, dict) else "dapr-agent-py"
            ),
            "_otel": inp.get("_otel") or {},
        }
        return {
            "kind": "agent",
            "callId": cid,
            "childInstanceId": child_instance_id,
            "childWorkflowName": "session_workflow",
            "childInput": child_input,
            "appId": (
                bridge.get("agentAppId") if isinstance(bridge, dict) else "dapr-agent-py"
            ),
            # Concurrency plan P2: prepare_script_call now returns the ensure
            # payload + the BFF's last host status so the pump's durable
            # readiness barrier can re-poll queued hosts.
            "agentHostStatus": (
                bridge.get("agentHostStatus") if isinstance(bridge, dict) else None
            ),
            "bridgePayload": {"sessionId": child_instance_id, "nodeId": cid},
        }

    # -- test helpers to complete real child tasks -------------------------
    def complete_child(self, call_id: str, result: Any, *, retries: int = 0) -> None:
        iid = script_child_instance_id(self.instance_id, call_id, retries)
        task = self.children.get(iid)
        assert task is not None, f"no child task for {call_id} (retries={retries}) -> {iid}"
        task.complete(result)

    def fire_cancel(self, reason: str = "stop") -> None:
        tasks = self.events.get("workflow.cancel") or []
        assert tasks, "cancel event never registered"
        tasks[0].complete({"reason": reason})

    def fire_control(self, call_id: str, action: str = "skip") -> None:
        tasks = self.events.get("script.call.control") or []
        assert tasks, "control event never registered"
        # Complete the most-recently created (still-pending) control task.
        for task in reversed(tasks):
            if not task.is_complete:
                task.complete({"callId": call_id, "action": action})
                return
        raise AssertionError("no pending control task")


# ---------------------------------------------------------------------------
# Generator driver
# ---------------------------------------------------------------------------
def drive(gen, ctx: FakeCtx, steps: list[Callable[[FakeCtx], None]]):
    """Advance the pump; at each unsatisfied when_any, run the next step."""
    send = None
    step_i = 0
    guard = 0
    while True:
        guard += 1
        assert guard < 1000, "runaway pump loop"
        try:
            task = gen.send(send)
        except StopIteration as exc:
            return exc.value
        if isinstance(task, WhenAnyTask):
            if not task.is_complete:
                assert step_i < len(steps), "when_any reached but no step left"
                steps[step_i](ctx)
                step_i += 1
            assert task.is_complete, "step did not satisfy the when_any composite"
            send = task.get_result()  # identity winner task
        else:
            assert getattr(task, "is_complete", False), f"leaf task not complete: {task}"
            send = task.get_result()


def base_input(**overrides) -> dict:
    payload = {
        "executionId": "e1",
        "dbExecutionId": "e1",
        "script": "return 1",
        "scriptSha256": "sha",
        "meta": {"name": "demo", "estimatedAgentCalls": 2},
        "args": {},
        "nested": False,
        "budgetTotal": None,
        "limits": {"maxConcurrentAgents": 5, "maxStructuredRetries": 5},
        "defaults": {"agentRuntime": "dapr-agent-py", "timeoutMinutes": 30},
        "workflowId": "wf1",
        "userId": "u1",
        "projectId": "p1",
        "_otel": {},
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
def test_happy_path_two_tasks_reverse_order():
    tasks = [agent_task("a" * 40 + "_0", label="A"), agent_task("b" * 40 + "_0", label="B")]
    ctx = FakeCtx(evaluator=make_evaluator(tasks, {"ok": True}))

    def complete_reverse(c: FakeCtx):
        c.complete_child("b" * 40 + "_0", {"success": True, "content": "second"})
        c.complete_child("a" * 40 + "_0", {"success": True, "content": "first"})

    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, [complete_reverse])
    assert result["success"] is True
    assert result["status"] == "completed"
    assert result["returnValue"] == {"ok": True}
    # Both recorded (drain-all in one batch), insertion order regardless of completion order.
    recorded = [inp["callId"] for inp in ctx.record_inputs]
    assert recorded == ["a" * 40 + "_0", "b" * 40 + "_0"]


def test_drain_all_batches_completed_children():
    tasks = [agent_task(f"{c*40}_0", label=c) for c in ("a", "b", "c")]
    ctx = FakeCtx(evaluator=make_evaluator(tasks, "done"))

    def complete_all(c: FakeCtx):
        for ch in ("a", "b", "c"):
            c.complete_child(f"{ch*40}_0", {"success": True, "content": ch})

    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, [complete_all])
    assert result["success"] is True
    # All three drained in a single when_any wake.
    assert len(ctx.record_inputs) == 3


def test_batch_v2_prepares_all_available_calls_before_scheduling_children():
    tasks = [agent_task(f"{c*40}_0", label=c) for c in ("a", "b", "c")]
    ctx = FakeCtx(evaluator=make_evaluator(tasks, "done"))
    inp = base_input(dispatchMode="batch-v2", limits={"maxConcurrentAgents": 3})

    def complete_all(c: FakeCtx):
        for ch in ("a", "b", "c"):
            c.complete_child(f"{ch*40}_0", {"success": True, "content": ch})

    result = drive(dynamic_script_workflow(ctx, inp), ctx, [complete_all])
    assert result["success"] is True
    assert [p["callId"] for p in ctx.prepare_inputs] == [f"{c*40}_0" for c in ("a", "b", "c")]
    first_child_i = next(i for i, a in enumerate(ctx.action_log) if a[0] == "child")
    prepare_indices = [
        i
        for i, a in enumerate(ctx.action_log)
        if a[0] == "activity" and a[1] == "prepare_script_call"
    ]
    assert len(prepare_indices) == 3
    assert max(prepare_indices) < first_child_i
    assert not any(a[0] == "activity" and a[1] == "spawn_session_for_workflow" for a in ctx.action_log)


def test_default_serial_mode_preserves_legacy_spawn_path_for_replay_safety():
    tasks = [agent_task("a" * 40 + "_0"), agent_task("b" * 40 + "_0")]
    ctx = FakeCtx(evaluator=make_evaluator(tasks, "done"))

    def complete_all(c: FakeCtx):
        c.complete_child("a" * 40 + "_0", {"success": True, "content": "a"})
        c.complete_child("b" * 40 + "_0", {"success": True, "content": "b"})

    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, [complete_all])
    assert result["success"] is True
    assert ctx.prepare_inputs == []
    assert any(
        a[0] == "activity" and a[1] == "spawn_session_for_workflow"
        for a in ctx.action_log
    )


def _queued_bridge_body(**overrides):
    body = {
        "childInput": {"foo": "bar"},
        "agentAppId": "agent-session-abc",
        "agentId": "ag1",
        "agentHostStatus": "queued",
    }
    body.update(overrides)
    return body


def test_batch_v2_queued_host_polls_on_durable_timer_until_ready():
    """Concurrency plan P2: the activity is single-shot; a queued per-session
    host is re-polled by the PUMP on durable ctx.create_timer ticks, and the
    call dispatches once the re-poll reports ready (refreshed childInput wins,
    the pump's overlay keys are preserved)."""
    cid = "a" * 40 + "_0"
    ready = _queued_bridge_body(
        childInput={"foo": "bar", "runtimeSandboxName": "sb-1"},
        agentHostStatus="ready",
    )
    ctx = FakeCtx(
        evaluator=make_evaluator([agent_task(cid, label="A")], "done"),
        spawn_result=make_spawn_sequence(_queued_bridge_body(), ready),
    )
    inp = base_input(dispatchMode="batch-v2")
    steps = [lambda c: c.complete_child(cid, {"success": True, "content": "ok"})]
    result = drive(dynamic_script_workflow(ctx, inp), ctx, steps)
    assert result["success"] is True

    # Exactly one workflow-level re-poll activity, preceded by a durable timer,
    # both BEFORE the child dispatch.
    spawn_polls = [
        i for i, a in enumerate(ctx.action_log)
        if a[0] == "activity" and a[1] == "spawn_session_for_workflow"
    ]
    timers = [i for i, a in enumerate(ctx.action_log) if a[0] == "timer"]
    first_child = next(i for i, a in enumerate(ctx.action_log) if a[0] == "child")
    assert len(spawn_polls) == 1
    assert timers and timers[0] < spawn_polls[0] < first_child

    # The re-polled body's childInput reaches the dispatched child, with the
    # prepared descriptor's overlay keys re-applied.
    iid = script_child_instance_id(ctx.instance_id, cid, 0)
    child_input = ctx.child_inputs[iid]
    assert child_input["runtimeSandboxName"] == "sb-1"
    assert child_input["nodeId"] == cid
    assert child_input["workflowExecutionId"] == "e1"
    assert child_input["agentAppId"] == "agent-session-abc"


def test_batch_v2_host_ready_timeout_journals_per_call_dispatch_error(monkeypatch):
    """Concurrency plan P2: a host that never leaves 'queued' times out at the
    pump's durable barrier and becomes a PER-CALL dispatchError journal row —
    the run itself proceeds (no whole-run TimeoutError)."""
    monkeypatch.setenv("AGENT_SESSION_HOST_READY_POLL_SECONDS", "5")
    monkeypatch.setenv("AGENT_SESSION_HOST_READY_TIMEOUT_SECONDS", "12")
    cid = "a" * 40 + "_0"
    ctx = FakeCtx(
        evaluator=make_evaluator([agent_task(cid)], "done"),
        spawn_result=_queued_bridge_body(),
    )
    result = drive(
        dynamic_script_workflow(ctx, base_input(dispatchMode="batch-v2")), ctx, []
    )
    assert result["success"] is True  # the script run completes
    assert ctx.children == {}  # the timed-out call never dispatched a child
    assert len(ctx.record_inputs) == 1
    raw = ctx.record_inputs[0]["raw"]
    assert raw["success"] is False
    assert "did not become ready" in raw["error"]
    # Deadline honored on the fake clock: 12s timeout / 5s poll = 2 re-polls.
    spawn_polls = [
        a for a in ctx.action_log
        if a[0] == "activity" and a[1] == "spawn_session_for_workflow"
    ]
    assert len(spawn_polls) == 2


def test_serial_mode_queued_host_polls_on_durable_timer_until_ready():
    """Concurrency plan P2 (serial path): spawn_session_with_host_wait re-calls
    the single-shot spawn activity on durable timers until the host is ready,
    then the child dispatches — replacing the old in-activity sleep loop."""
    cid = "a" * 40 + "_0"
    ready = _queued_bridge_body(agentHostStatus="ready")
    ctx = FakeCtx(
        evaluator=make_evaluator([agent_task(cid)], "done"),
        spawn_result=make_spawn_sequence(_queued_bridge_body(), ready),
    )
    steps = [lambda c: c.complete_child(cid, {"success": True, "content": "ok"})]
    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, steps)
    assert result["success"] is True

    spawn_calls = [
        i for i, a in enumerate(ctx.action_log)
        if a[0] == "activity" and a[1] == "spawn_session_for_workflow"
    ]
    timers = [i for i, a in enumerate(ctx.action_log) if a[0] == "timer"]
    first_child = next(i for i, a in enumerate(ctx.action_log) if a[0] == "child")
    # ensure -> timer -> re-poll -> dispatch
    assert len(spawn_calls) == 2
    assert timers and spawn_calls[0] < timers[0] < spawn_calls[1] < first_child


def test_child_failure_journals_null():
    cid = "a" * 40 + "_0"
    tasks = [agent_task(cid)]
    records = []

    def record_fn(inp):
        records.append(inp)
        return {"status": "null"}

    ctx = FakeCtx(evaluator=make_evaluator(tasks, None), record_fn=record_fn)

    def fail_child(c: FakeCtx):
        # Fail the real child task -> get_result() raises -> pump maps to null.
        from dapr.ext.workflow._durabletask.internal import protos as pb

        iid = script_child_instance_id(c.instance_id, cid, 0)
        c.children[iid].fail("boom", pb.TaskFailureDetails(errorType="E", errorMessage="boom"))

    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, [fail_child])
    assert result["success"] is True  # script itself completed (agent()->null)
    assert records and records[0]["raw"].get("success") is False
    assert "boom" in json.dumps(records[0]["raw"])


def test_cancel_event_wins():
    cid = "a" * 40 + "_0"
    ctx = FakeCtx(evaluator=make_evaluator([agent_task(cid)], "x"))

    result = drive(
        dynamic_script_workflow(ctx, base_input()),
        ctx,
        [lambda c: c.fire_cancel("user stop")],
    )
    assert result["success"] is False
    assert result["cancelled"] is True
    assert result["status"] == "cancelled"
    assert "user stop" in result["error"]


def test_skip_control_event():
    cid = "a" * 40 + "_0"
    ctx = FakeCtx(evaluator=make_evaluator([agent_task(cid)], "done"))

    result = drive(
        dynamic_script_workflow(ctx, base_input()),
        ctx,
        [lambda c: c.fire_control(cid, "skip")],
    )
    assert result["success"] is True
    # The skipped call was journaled (raw.skipped=True).
    skip_records = [r for r in ctx.record_inputs if r["raw"].get("skipped")]
    assert len(skip_records) == 1
    assert skip_records[0]["callId"] == cid


def test_batch_v2_skip_requests_lifecycle_stop_for_agent_session():
    cid = "a" * 40 + "_0"
    ctx = FakeCtx(evaluator=make_evaluator([agent_task(cid)], "done"))

    result = drive(
        dynamic_script_workflow(ctx, base_input(dispatchMode="batch-v2")),
        ctx,
        [lambda c: c.fire_control(cid, "skip")],
    )
    assert result["success"] is True
    assert len(ctx.stop_inputs) == 1
    assert ctx.stop_inputs[0]["sessionId"] == script_child_instance_id(ctx.instance_id, cid, 0)
    assert ctx.stop_inputs[0]["mode"] == "terminate"


def test_structured_retry_requeue_then_cap():
    cid = "a" * 40 + "_0"
    schema = {"type": "object", "required": ["x"], "properties": {"x": {"type": "number"}}}
    tasks = [agent_task(cid, schema=schema)]

    def record_fn(inp):
        retries = inp["spec"]["retries"]
        cap = inp["spec"]["maxStructuredRetries"]
        if retries < cap:
            return {"status": "retry_structured", "feedback": f"bad@{retries}"}
        return {"status": "error", "errorCode": "error_max_structured_output_retries"}

    ctx = FakeCtx(
        evaluator=make_evaluator(tasks, "done"),
        record_fn=record_fn,
    )
    inp = base_input(limits={"maxConcurrentAgents": 5, "maxStructuredRetries": 2})

    steps = [
        lambda c: c.complete_child(cid, {"content": "nope"}, retries=0),
        lambda c: c.complete_child(cid, {"content": "nope"}, retries=1),
        lambda c: c.complete_child(cid, {"content": "nope"}, retries=2),
    ]
    result = drive(dynamic_script_workflow(ctx, inp), ctx, steps)
    assert result["success"] is True
    # Three dispatches at __run__0/1/2 (retry = NEW corrective session).
    dispatched = [a for a in ctx.action_log if a[0] == "child"]
    assert len(dispatched) == 3
    assert dispatched[0][2].endswith("__run__0")
    assert dispatched[1][2].endswith("__run__1")
    assert dispatched[2][2].endswith("__run__2")
    # Retry feedback + previous-attempt block reach the corrective session prompt.
    retry_input = ctx.child_inputs[dispatched[1][2]]
    assert isinstance(retry_input, dict)


def test_concurrency_gate_third_waits_for_completion():
    tasks = [agent_task(f"{c*40}_0", label=c) for c in ("a", "b", "c")]
    ctx = FakeCtx(evaluator=make_evaluator(tasks, "done"))
    inp = base_input(limits={"maxConcurrentAgents": 2, "maxStructuredRetries": 5})

    steps = [
        lambda c: c.complete_child("a" * 40 + "_0", {"success": True, "content": "a"}),
        lambda c: (
            c.complete_child("b" * 40 + "_0", {"success": True, "content": "b"}),
            c.complete_child("c" * 40 + "_0", {"success": True, "content": "c"}),
        ),
    ]
    result = drive(dynamic_script_workflow(ctx, inp), ctx, steps)
    assert result["success"] is True

    dispatched = [a[2] for a in ctx.action_log if a[0] == "child"]
    a_iid = script_child_instance_id(ctx.instance_id, "a" * 40 + "_0", 0)
    b_iid = script_child_instance_id(ctx.instance_id, "b" * 40 + "_0", 0)
    c_iid = script_child_instance_id(ctx.instance_id, "c" * 40 + "_0", 0)
    # a + b dispatched in round 1 (cap 2); c only after a resolves.
    assert dispatched.index(a_iid) < dispatched.index(c_iid)
    assert dispatched.index(b_iid) < dispatched.index(c_iid)
    # c dispatch happens after a's record (proof the gate held).
    a_record_idx = next(
        i for i, a in enumerate(ctx.action_log)
        if a[0] == "activity" and a[1] == "record_script_call_result" and a[2] == "a" * 40 + "_0"
    )
    c_dispatch_idx = next(
        i for i, a in enumerate(ctx.action_log) if a[0] == "child" and a[2] == c_iid
    )
    assert c_dispatch_idx > a_record_idx


def test_budget_exhaustion_stops_dispatch():
    cid = "a" * 40 + "_0"
    tasks = [agent_task(cid)]
    ctx = FakeCtx(
        evaluator=make_evaluator(tasks, "budget-done", honor_budget=True),
        usage_values=[0, 500000],  # round1 spent=0, round2 spent > total
    )
    inp = base_input(budgetTotal=100000)

    steps = [lambda c: c.complete_child(cid, {"success": True, "content": "ok"})]
    result = drive(dynamic_script_workflow(ctx, inp), ctx, steps)
    assert result["success"] is True
    assert result["returnValue"] == "budget-done"
    # Only ONE dispatch — budget exhaustion halted further work.
    dispatched = [a for a in ctx.action_log if a[0] == "child"]
    assert len(dispatched) == 1


def test_journal_import_called_when_configured():
    ctx = FakeCtx(evaluator=make_evaluator([], "immediate"))
    inp = base_input(journalImportFromExecutionId="prev-exec")
    result = drive(dynamic_script_workflow(ctx, inp), ctx, [])
    assert result["success"] is True
    imports = [a for a in ctx.action_log if a[0] == "activity" and a[1] == "import_script_journal"]
    assert len(imports) == 1
    assert imports[0][2] == "prev-exec"
    # First activity is the import (before budget/evaluate).
    first_activity = next(a for a in ctx.action_log if a[0] == "activity")
    assert first_activity[1] == "import_script_journal"


def test_nested_flag_passed_through_to_workflow_child():
    cid = "w" * 40 + "_0"
    tasks = [workflow_task(cid, "child-workflow")]
    ctx = FakeCtx(evaluator=make_evaluator(tasks, "outer-done"))

    steps = [lambda c: c.complete_child(cid, {"success": True, "content": "child ok"})]
    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, steps)
    assert result["success"] is True
    # The nested dynamic_script_workflow child carries nested=True + same executionId.
    child = [a for a in ctx.action_log if a[0] == "child"][0]
    child_input = ctx.child_inputs[child[2]]
    assert child[1] == "dynamic_script_workflow_v1"
    assert child_input["nested"] is True
    assert child_input["executionId"] == "e1"


def test_script_error_is_terminal():
    ctx = FakeCtx(evaluator=lambda inp: plan_script_error("boom in script"))
    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, [])
    assert result["success"] is False
    assert result["status"] == "script_error"
    assert "boom in script" in result["error"]


def test_replay_determinism_identical_action_log():
    tasks = [agent_task(f"{c*40}_0", label=c) for c in ("a", "b")]

    def run_once():
        ctx = FakeCtx(evaluator=make_evaluator(tasks, {"ok": 1}))
        steps = [
            lambda c: (
                c.complete_child("a" * 40 + "_0", {"success": True, "content": "a"}),
                c.complete_child("b" * 40 + "_0", {"success": True, "content": "b"}),
            )
        ]
        drive(dynamic_script_workflow(ctx, base_input()), ctx, steps)
        return ctx.action_log, ctx.custom_statuses

    log1, status1 = run_once()
    log2, status2 = run_once()
    assert log1 == log2
    assert status1 == status2


# ---------------------------------------------------------------------------
# Contract-fixture cross-checks (SSOT with the evaluator suite)
# ---------------------------------------------------------------------------
def test_evaluate_request_and_response_keys_match_contract():
    contract = json.loads(CONTRACT_PATH.read_text())
    # 1.2.0 = additive-only bump (code-first cutover P0): reserves task kinds
    # action/sleep/event, agent() semanticOpts key 'agent', and advisory
    # tasks[].position. callId derivation stays FROZEN — the vector test below
    # proves every pre-1.2.0 callId is byte-identical.
    assert contract["contractVersion"] == "1.2.0"
    accepted_request_keys = set(contract["request"].keys())
    # Keys the evaluate_script activity puts on the /evaluate request body.
    produced_request_keys = {
        "script",
        "scriptSha256",
        "meta",
        "args",
        "nested",
        "budget",
        "completedResults",
        "knownCallIds",
        "seenLogCount",
        "limits",
    }
    assert produced_request_keys <= accepted_request_keys, (
        produced_request_keys - accepted_request_keys
    )

    # Response keys the pump consumes must all be present in each contract shape.
    consumed_response_keys = {"status", "tasks", "returnValue", "error", "phases", "newLogs"}
    for shape_name in ("need", "done", "script_error"):
        shape = contract["response"][shape_name]
        assert consumed_response_keys <= set(shape.keys()), (shape_name, consumed_response_keys - set(shape.keys()))

    # completedResult statuses the activity emits match the contract vocabulary.
    assert set(contract["completedResultStatuses"]) == {"done", "null", "error", "skipped"}


@pytest.mark.skipif(not CALLID_VECTORS_PATH.exists(), reason="callid vectors fixture absent")
def test_can_consume_callid_vector_task_specs():
    vectors = json.loads(CALLID_VECTORS_PATH.read_text())
    entries = vectors if isinstance(vectors, list) else vectors.get("vectors", [])
    assert entries, "callid vectors fixture is empty"
    ctx = FakeCtx(evaluator=make_evaluator([], "x"))
    seen = 0
    for entry in entries:
        for task in entry.get("expectedTasks", []):
            call_id = task.get("callId")
            assert isinstance(call_id, str) and call_id
            # agent/workflow/team are the FROZEN 1.1.0 kinds; action/sleep/event
            # are the contract-1.2.0 additive kinds (evaluator 1.3.0).
            assert task.get("kind") in {"agent", "workflow", "team", "action", "sleep", "event"}
            # The pump must derive a routable child instance id from every callId
            # (charset-sanitized, lifecycle-regex compatible).
            iid = script_child_instance_id(ctx.instance_id, call_id, 0)
            assert "__durable-script__" in iid and iid.endswith("__run__0")
            # And it must accept the task spec shape end-to-end (build an agent_task
            # the evaluator would emit, feed it through spec assembly).
            if task.get("kind") == "agent":
                built = agent_task(
                    call_id,
                    prompt=task.get("prompt", ""),
                    label=task.get("label"),
                    schema=task.get("schema"),
                )
                assert built["callId"] == call_id
            seen += 1
    assert seen > 0


# ---------------------------------------------------------------------------
# Duplicate-occurrence identity: identical un-labeled agent() calls share a
# baseHash and differ ONLY in the _<occurrence> callId suffix (chars 40+).
# The child instance id must keep that tail — callId[:16] alone collided all
# duplicates onto ONE child/session id (Dapr serializes them through a shared
# session or wedges the parent; per-call skip kills the session every
# duplicate rides on).
# ---------------------------------------------------------------------------
def test_duplicate_prompt_occurrences_get_distinct_child_ids():
    base = "f" * 40
    iid0 = script_child_instance_id("dsw-x-exec-e1", base + "_0", 0)
    iid1 = script_child_instance_id("dsw-x-exec-e1", base + "_1", 0)
    iid2 = script_child_instance_id("dsw-x-exec-e1", base + "_2", 0)
    assert len({iid0, iid1, iid2}) == 3
    # Still lifecycle wedge-finalize + nodeIdFromChildSessionId compatible.
    pat = re.compile(r"__durable(?:-[a-z0-9-]+)?__(.+?)__run__\d+")
    for iid in (iid0, iid1, iid2):
        assert pat.search(iid), iid
    # Deterministic per (callId, retries): replay recomputes the same id...
    assert script_child_instance_id("dsw-x-exec-e1", base + "_0", 0) == iid0
    # ...while the structured-retry counter still differentiates re-runs.
    assert script_child_instance_id("dsw-x-exec-e1", base + "_0", 1) != iid0


def test_unknown_task_kind_journals_dispatch_error_not_phantom_agent():
    """Contract-1.2.0 version-skew guard: a newer evaluator may emit reserved
    kinds (action/sleep/event) before this orchestrator implements them. The
    pump must journal a dispatch error and resolve the call — the pre-guard
    behavior defaulted unknown kinds to 'agent' and dispatched a phantom
    empty-prompt session."""
    cid = "e" * 40 + "_0"
    future = agent_task(cid, prompt="")
    future["kind"] = "action"  # reserved by contract 1.2.0, not yet implemented
    ctx = FakeCtx(evaluator=make_evaluator([future], {"ok": True}))

    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, [])
    assert result["success"] is True
    # No child workflow was dispatched for the unknown kind.
    assert [a for a in ctx.action_log if a[0] == "child"] == []
    # The call was journaled with the skew reason.
    assert [inp["callId"] for inp in ctx.record_inputs] == [cid]
    raw = ctx.record_inputs[0]["raw"]
    assert raw["success"] is False and "unknown task kind" in raw["error"]


def test_duplicate_prompt_agent_calls_dispatch_distinct_children():
    """End-to-end through the pump: two identical un-labeled agent() calls
    (same baseHash, occurrences 0/1) dispatch TWO distinct children, each
    individually completable, both journaled under their own callId."""
    base = "d" * 40
    t0 = agent_task(base + "_0", prompt="same prompt")
    t1 = agent_task(base + "_1", prompt="same prompt")
    t1["occurrence"] = 1
    ctx = FakeCtx(evaluator=make_evaluator([t0, t1], {"ok": True}))

    def complete_both(c: FakeCtx):
        c.complete_child(base + "_0", {"success": True, "content": "first"})
        c.complete_child(base + "_1", {"success": True, "content": "second"})

    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, [complete_both])
    assert result["success"] is True
    dispatched = [a[2] for a in ctx.action_log if a[0] == "child"]
    assert len(dispatched) == 2 and len(set(dispatched)) == 2, dispatched
    recorded = sorted(inp["callId"] for inp in ctx.record_inputs)
    assert recorded == [base + "_0", base + "_1"]


# ---------------------------------------------------------------------------
# Dispatch robustness: a bad opts.agentType must not crash the whole workflow
# (spec-alignment audit regression — agent() returns null on death, not a run
# failure). The registry raises on an unresolvable runtime id / persona value;
# _start_script_call must catch it and return None so the pump journals THIS
# call as null and its siblings proceed.
# ---------------------------------------------------------------------------
def test_bad_agent_type_returns_none_instead_of_crashing(monkeypatch):
    import workflows.script_agent_dispatch as d

    def _boom(*args, **kwargs):
        raise RuntimeError("Unsupported durable/run agentRuntime 'Explore'")

    # The registry resolve is imported into the dispatch module's namespace.
    monkeypatch.setattr(d, "_resolve_native_agent_runtime", _boom)

    class _MiniCtx:
        instance_id = "dsw-test-exec-e1"

    gen = d._start_script_call(
        _MiniCtx(),
        call_id="c" * 40 + "_0",
        spec={"kind": "agent", "prompt": "hi", "opts": {"agentType": "Explore"}},
        exec_id="e1",
        meta={"name": "x"},
        defaults={},
        limits={},
        workflow_id=None,
        user_id=None,
        project_id=None,
        otel={},
    )
    # The resolve raises BEFORE any yield, so the generator returns None
    # immediately — driving it raises StopIteration whose value is None.
    with pytest.raises(StopIteration) as si:
        next(gen)
    assert si.value.value is None


# ---------------------------------------------------------------------------
# Spec-alignment additions (gaps implemented 2026-07): nested budget sharing,
# verbatim/absent workflow() args, workflow() dispatch-error channel, and the
# meta.phases[].model fallback.
# ---------------------------------------------------------------------------
class _DispatchCtx:
    """Minimal ctx for driving _start_script_call's workflow branch."""

    instance_id = "dsw-test-exec-e1"

    def __init__(self):
        self.captured_child = None

    def call_activity(self, fn, *, input=None, retry_policy=None):
        return ("activity", getattr(fn, "__name__", str(fn)), input)

    def call_child_workflow(self, name, *, input=None, instance_id=None, **kwargs):
        self.captured_child = {"name": name, "input": input, "instance_id": instance_id}
        return "CHILD_TASK"


def _drive_workflow_dispatch(spec, *, budget_total=None, resolve_result=None):
    import workflows.script_agent_dispatch as d

    ctx = _DispatchCtx()
    gen = d._start_script_call(
        ctx,
        call_id="w" * 40 + "_0",
        spec=spec,
        exec_id="e1",
        meta={"name": "parent"},
        defaults={},
        limits={},
        budget_total=budget_total,
        workflow_id=None,
        user_id=None,
        project_id=None,
        otel={},
    )
    next(gen)  # the resolve_script_workflow activity
    result = None
    try:
        gen.send(
            resolve_result
            if resolve_result is not None
            else {"success": True, "script": "s", "scriptSha256": "h", "meta": {"name": "c"}}
        )
    except StopIteration as si:
        result = si.value
    return ctx, result


def test_nested_workflow_dispatch_shares_parent_budget_and_verbatim_args():
    spec = {"kind": "workflow", "workflowRef": "child", "args": ["a", "b"], "retries": 0}
    ctx, result = _drive_workflow_dispatch(spec, budget_total=500)
    assert result == "CHILD_TASK"
    child_input = ctx.captured_child["input"]
    # Shared token pool: the nested child sees the SAME budgetTotal (and,
    # aggregating by the same executionId, tree-wide spent()).
    assert child_input["budgetTotal"] == 500
    assert child_input["nested"] is True
    # args pass VERBATIM — arrays (and scalars) are not coerced to {}.
    assert child_input["args"] == ["a", "b"]


def test_nested_workflow_dispatch_omits_absent_args():
    spec = {"kind": "workflow", "workflowRef": "child", "retries": 0}
    ctx, result = _drive_workflow_dispatch(spec, budget_total=None)
    assert result == "CHILD_TASK"
    child_input = ctx.captured_child["input"]
    # Key-absence propagates: the child's `args` global must be undefined.
    assert "args" not in child_input
    assert child_input["budgetTotal"] is None


def test_unresolved_workflow_ref_returns_dispatch_error():
    spec = {"kind": "workflow", "workflowRef": "missing", "retries": 0}
    ctx, result = _drive_workflow_dispatch(
        spec, resolve_result={"success": False, "error": "not found"}
    )
    # The dispatch-error channel (NOT None): the pump journals it as a
    # workflow_child_error so the script's workflow() call THROWS the reason.
    assert isinstance(result, dict)
    assert "missing" in result["dispatchError"]
    assert "not found" in result["dispatchError"]
    assert ctx.captured_child is None


def test_phase_model_fallback_resolution_order():
    import workflows.script_agent_dispatch as d

    meta = {"phases": [{"title": "Heavy", "model": "zai/glm-5.2"}, {"title": "Light"}]}
    # phase model applies when opts.model absent
    cfg = d._build_agent_config({"phase": "Heavy"}, {}, "", meta)
    assert cfg["modelSpec"] == "zai/glm-5.2"
    assert cfg["model"] == "zai/glm-5.2"
    # opts.model always wins over the phase model
    cfg = d._build_agent_config(
        {"phase": "Heavy", "model": "anthropic/claude-opus-4-8"}, {}, "", meta
    )
    assert cfg["modelSpec"] == "anthropic/claude-opus-4-8"
    # a phase without a model falls through to defaults (dapr-agent-py gate)
    cfg = d._build_agent_config({"phase": "Light"}, {"model": "zai/glm-5.2"}, "dapr-agent-py", meta)
    assert cfg["modelSpec"] == "zai/glm-5.2"
    # ...but NOT for other runtimes (cross-provider default guard unchanged)
    cfg = d._build_agent_config({"phase": "Light"}, {"model": "zai/glm-5.2"}, "claude-agent-py", meta)
    assert "modelSpec" not in cfg
    # unmatched phase title -> no phase model
    cfg = d._build_agent_config({"phase": "Nope"}, {}, "", meta)
    assert "modelSpec" not in cfg


def test_unresolvable_workflow_ref_loops_instead_of_stalling():
    """LIVE-CAUGHT regression (dev parity-probe): a workflow() call with an
    unknown ref is journaled as workflow_child_error AT DISPATCH (no child
    task), so the round dispatches nothing — the pump must LOOP so the next
    evaluate observes the journaled row (the script's try/catch sees the
    throw), NOT fail with "no dispatchable work"."""
    wtask = workflow_task("w" * 40 + "_0", "this-workflow-does-not-exist")
    ctx = FakeCtx(
        evaluator=make_evaluator([wtask], {"caught": "workflow() could not resolve"}),
        resolve_result={"success": False, "error": "not found"},
    )
    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, steps=[])

    assert result["success"] is True
    assert result["returnValue"] == {"caught": "workflow() could not resolve"}
    # The failed call was journaled with the dispatch-error reason...
    assert len(ctx.record_inputs) == 1
    raw = ctx.record_inputs[0]["raw"]
    assert raw["success"] is False
    assert "this-workflow-does-not-exist" in raw["error"]
    assert "not found" in raw["error"]
    # ...and NO child workflow was ever created.
    assert ctx.children == {}


def test_nested_run_never_persists_to_the_shared_execution_row():
    """LIVE-CAUGHT regression: a workflow() child shares the ROOT run's
    executionId; its terminal persist_results_to_db clobbered the shared row
    (success + the CHILD's returnValue) while the parent was still running, and
    the parent's later patch could not land. Nested pumps must return their
    result WITHOUT persisting — the parent journals it via
    record_script_call_result."""
    ctx = FakeCtx(evaluator=make_evaluator([], {"child": True}))
    result = drive(
        dynamic_script_workflow(ctx, base_input(nested=True)), ctx, steps=[]
    )
    assert result["success"] is True
    assert result["returnValue"] == {"child": True}
    persists = [a for a in ctx.action_log if a[0] == "activity" and a[1] == "persist_results_to_db"]
    assert persists == []


def test_root_run_still_persists_terminal_results():
    ctx = FakeCtx(evaluator=make_evaluator([], {"root": True}))
    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, steps=[])
    assert result["success"] is True
    persists = [a for a in ctx.action_log if a[0] == "activity" and a[1] == "persist_results_to_db"]
    assert len(persists) == 1


def test_agent_dispatch_stamps_resolved_runtime_on_agent_config(monkeypatch):
    """LIVE-CAUGHT regression: the ensure-for-workflow bridge resolves the
    runtime descriptor from agentConfig.runtime (swap-safety gate + the
    per-session OpenShell auto-sandbox provision). The script dispatch never
    stamped it, so script-spawned dapr-agent-py sessions got NO workspace
    sandbox and every OpenShell tool failed with gRPC "sandbox not found"."""
    import workflows.script_agent_dispatch as d

    monkeypatch.setattr(
        d,
        "_resolve_native_agent_runtime",
        lambda args, cfg: ("dapr-agent-py", {"app_id": "dapr-agent-py"}),
    )

    captured = {}

    class _Ctx:
        instance_id = "dsw-test-exec-e1"
        # Concurrency plan P2: spawn_session_with_host_wait derives its poll
        # deadline from the workflow clock even when no host wait is needed.
        current_utc_datetime = datetime(2026, 1, 1, tzinfo=timezone.utc)

        def call_activity(self, fn, *, input=None, retry_policy=None):
            name = getattr(fn, "__name__", str(fn))
            if name == "spawn_session_for_workflow":
                captured["bridge_payload"] = input
            return ("activity", name, input)

        def call_child_workflow(self, name, *, input=None, instance_id=None, **kw):
            captured["child_input"] = input
            return "CHILD_TASK"

    gen = d._start_script_call(
        _Ctx(),
        call_id="a" * 40 + "_0",
        spec={"kind": "agent", "prompt": "hi", "opts": {"effort": "low"}, "retries": 0},
        exec_id="e1",
        meta={"name": "probe"},
        defaults={"agentRuntime": "dapr-agent-py", "model": "zai/glm-5.2"},
        limits={},
        budget_total=None,
        workflow_id=None,
        user_id=None,
        project_id=None,
        otel={},
    )
    next(gen)  # the spawn activity yield
    result = None
    try:
        gen.send({"childInput": {"x": 1}, "agentAppId": "dapr-agent-py", "agentId": "ag1"})
    except StopIteration as si:
        result = si.value
    assert result == "CHILD_TASK"

    agent_config = captured["bridge_payload"]["agentConfig"]
    assert agent_config["runtime"] == "dapr-agent-py"
    # Existing stamps unchanged.
    assert agent_config["modelSpec"] == "zai/glm-5.2"
    assert agent_config["reasoningEffort"] == "low"


# ---------------------------------------------------------------------------
# Provider-native structured output: hybrid routing + responseJsonSchema stamp
# (script_agent_dispatch._build_agent_config).
# ---------------------------------------------------------------------------
def test_schema_call_routes_to_structured_model_and_stamps_schema(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    monkeypatch.setenv("DYNAMIC_SCRIPT_STRUCTURED_MODEL", "openai/gpt-5.5")
    schema = {"type": "object", "required": ["real"], "properties": {"real": {"type": "boolean"}}}
    # schema'd call, no explicit model -> route to the structured model + stamp
    cfg = d._build_agent_config({"schema": schema}, {"model": "zai/glm-5.2"}, "dapr-agent-py", {})
    assert cfg["modelSpec"] == "openai/gpt-5.5"
    assert cfg["responseJsonSchema"] == schema


def test_schema_call_explicit_model_wins_still_stamps_schema(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    # per-call opts.model wins (GLM) -> Tier-2 json_object; schema still stamped
    cfg = d._build_agent_config({"schema": schema, "model": "zai/glm-5.2"}, {}, "dapr-agent-py", {})
    assert cfg["modelSpec"] == "zai/glm-5.2"
    assert cfg["responseJsonSchema"] == schema


def test_non_schema_call_stays_on_default_model(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    cfg = d._build_agent_config({}, {"model": "zai/glm-5.2"}, "dapr-agent-py", {})
    assert cfg["modelSpec"] == "zai/glm-5.2"
    assert "responseJsonSchema" not in cfg


def test_kill_switch_off_disables_native_structured(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.setenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", "false")
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    cfg = d._build_agent_config({"schema": schema}, {"model": "zai/glm-5.2"}, "dapr-agent-py", {})
    # reverts to GLM default + no native stamp (today's prompt-contract behavior)
    assert cfg["modelSpec"] == "zai/glm-5.2"
    assert "responseJsonSchema" not in cfg


def test_native_structured_excludes_unsupported_runtime(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    # non-dapr runtime (e.g. claude-agent-py, Anthropic-only) -> no routing/stamp
    cfg = d._build_agent_config({"schema": schema}, {"model": "zai/glm-5.2"}, "claude-agent-py", {})
    assert "responseJsonSchema" not in cfg
    assert "modelSpec" not in cfg


def test_native_structured_support_is_registry_driven(monkeypatch):
    import workflows.script_agent_dispatch as d

    class FutureRuntime:
        capabilities = {
            "structuredOutputMode": "tool",
            "structuredOutputJsonSchemaDraft": "2020-12",
        }

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    monkeypatch.setattr(
        d.runtime_registry.registry,
        "by_id",
        lambda runtime_id: FutureRuntime() if runtime_id == "future-runtime" else None,
    )
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    cfg = d._build_agent_config(
        {"schema": schema, "model": "kimi/kimi-k3"},
        {},
        "future-runtime",
        {},
    )

    assert cfg["responseJsonSchema"] == schema
    assert cfg["structuredOutputMode"] == "tool"


def test_pydantic_runtime_gets_kimi_structured_output_tool(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    monkeypatch.delenv("DYNAMIC_SCRIPT_STRUCTURED_TOOL", raising=False)
    schema = {
        "type": "object",
        "required": ["summary"],
        "properties": {"summary": {"type": "string"}},
    }
    cfg = d._build_agent_config(
        {"schema": schema, "model": "kimi/kimi-k3"},
        {},
        "pydantic-ai-agent-py",
        {},
    )

    assert cfg["modelSpec"] == "kimi/kimi-k3"
    assert cfg["responseJsonSchema"] == schema
    assert cfg["structuredOutputMode"] == "tool"


@pytest.mark.parametrize(
    "runtime",
    ["claude-code-cli", "claude-code-cli-glm", "codex-cli", "agy-cli"],
)
def test_cli_schema_call_gets_tool_structured_mode(monkeypatch, runtime):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_CLI_STRUCTURED_OUTPUT", raising=False)
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    cfg = d._build_agent_config({"schema": schema}, {}, runtime, {})
    assert cfg["responseJsonSchema"] == schema
    assert cfg["structuredOutputMode"] == "tool"
    # CLI runtimes do not inherit a multi-provider default model.
    assert "modelSpec" not in cfg


def test_claude_code_cli_structured_mode_kill_switch(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.setenv("DYNAMIC_SCRIPT_CLI_STRUCTURED_OUTPUT", "false")
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    cfg = d._build_agent_config({"schema": schema}, {}, "claude-code-cli", {})
    assert "responseJsonSchema" not in cfg
    assert "structuredOutputMode" not in cfg


def test_claude_code_cli_non_object_schema_stays_prompt_only(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_CLI_STRUCTURED_OUTPUT", raising=False)
    schema = {"type": "array", "items": {"type": "string"}}
    cfg = d._build_agent_config({"schema": schema}, {}, "claude-code-cli", {})
    assert "responseJsonSchema" not in cfg
    assert "structuredOutputMode" not in cfg

# ---------------------------------------------------------------------------
# StructuredOutput TOOL mode (Tier-2 upgrade): a schema'd call explicitly
# resolved to GLM stamps structuredOutputMode=tool.
# ---------------------------------------------------------------------------
def test_glm_schema_call_gets_structured_tool_mode(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    monkeypatch.delenv("DYNAMIC_SCRIPT_STRUCTURED_TOOL", raising=False)
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    cfg = d._build_agent_config({"schema": schema, "model": "zai/glm-5.2"}, {}, "dapr-agent-py", {})
    assert cfg["structuredOutputMode"] == "tool"
    assert cfg["responseJsonSchema"] == schema


def test_openai_schema_call_never_gets_tool_mode(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    monkeypatch.delenv("DYNAMIC_SCRIPT_STRUCTURED_TOOL", raising=False)
    # env-routed to OpenAI -> strict json_schema (stronger than the tool)
    monkeypatch.setenv("DYNAMIC_SCRIPT_STRUCTURED_MODEL", "openai/gpt-5.5")
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    cfg = d._build_agent_config({"schema": schema}, {"model": "zai/glm-5.2"}, "dapr-agent-py", {})
    assert cfg["modelSpec"].startswith("openai/")
    assert "structuredOutputMode" not in cfg


def test_default_schema_routing_is_kimi_k3_tool_mode(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    monkeypatch.delenv("DYNAMIC_SCRIPT_STRUCTURED_TOOL", raising=False)
    monkeypatch.delenv("DYNAMIC_SCRIPT_STRUCTURED_MODEL", raising=False)
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    # schema'd call with no explicit model uses Kimi K3 and keeps normal tools
    # available before StructuredOutput finalization.
    cfg = d._build_agent_config({"schema": schema}, {"model": "zai/glm-5.2"}, "dapr-agent-py", {})
    assert cfg["modelSpec"] == "kimi/kimi-k3"
    assert cfg["structuredOutputMode"] == "tool"
    assert cfg["responseJsonSchema"] == schema


@pytest.mark.parametrize("spec", ["kimi/kimi-k3", "kimi-k3", "moonshot/kimi-k3"])
def test_kimi_k3_aliases_use_structured_tool_mode(monkeypatch, spec):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    monkeypatch.delenv("DYNAMIC_SCRIPT_STRUCTURED_TOOL", raising=False)
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    cfg = d._build_agent_config(
        {"schema": schema, "model": spec}, {}, "dapr-agent-py", {}
    )
    assert cfg["structuredOutputMode"] == "tool"
    assert cfg["responseJsonSchema"] == schema


def test_kimi_k3_non_object_schema_stays_native_strict(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    monkeypatch.delenv("DYNAMIC_SCRIPT_STRUCTURED_TOOL", raising=False)
    schema = {"type": "array", "items": {"type": "string"}}
    cfg = d._build_agent_config(
        {"schema": schema, "model": "kimi/kimi-k3"}, {}, "dapr-agent-py", {}
    )
    assert cfg["responseJsonSchema"] == schema
    assert "structuredOutputMode" not in cfg


def test_kimi_k3_structured_tool_kill_switch_uses_native_strict(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    monkeypatch.setenv("DYNAMIC_SCRIPT_STRUCTURED_TOOL", "false")
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    cfg = d._build_agent_config(
        {"schema": schema, "model": "kimi/kimi-k3"}, {}, "dapr-agent-py", {}
    )
    assert cfg["responseJsonSchema"] == schema
    assert "structuredOutputMode" not in cfg


def test_anthropic_and_deepseek_schema_calls_get_tool_mode(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    monkeypatch.delenv("DYNAMIC_SCRIPT_STRUCTURED_TOOL", raising=False)
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    for spec in ("anthropic/claude-opus-4-8", "deepseek/deepseek-chat"):
        cfg = d._build_agent_config({"schema": schema, "model": spec}, {}, "dapr-agent-py", {})
        assert cfg["structuredOutputMode"] == "tool", spec
        assert cfg["responseJsonSchema"] == schema, spec


def test_structured_tool_kill_switch_reverts_to_json_object(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    monkeypatch.setenv("DYNAMIC_SCRIPT_STRUCTURED_TOOL", "false")
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    cfg = d._build_agent_config({"schema": schema, "model": "zai/glm-5.2"}, {}, "dapr-agent-py", {})
    # schema still stamped (json_object fallback) but no tool mode
    assert cfg["responseJsonSchema"] == schema
    assert "structuredOutputMode" not in cfg


def test_non_object_schema_never_rides_the_tool(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    monkeypatch.delenv("DYNAMIC_SCRIPT_STRUCTURED_TOOL", raising=False)
    schema = {"type": "array", "items": {"type": "string"}}
    # tool args are always JSON objects — an array schema can't ride the tool
    cfg = d._build_agent_config({"schema": schema, "model": "zai/glm-5.2"}, {}, "dapr-agent-py", {})
    assert cfg["responseJsonSchema"] == schema
    assert "structuredOutputMode" not in cfg


def test_tool_mode_output_contract_instructs_tool_call():
    import workflows.script_agent_dispatch as d

    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    spec = {"prompt": "Do the thing.", "opts": {"schema": schema}}
    tool_msg = d._build_initial_message(spec, structured_tool=True)
    assert "StructuredOutput" in tool_msg
    assert "CLI MCP runtimes" in tool_msg
    assert "mcp__structured__StructuredOutput" in tool_msg
    assert "fenced" not in tool_msg
    default_msg = d._build_initial_message(spec)
    assert "StructuredOutput" not in default_msg
    assert "```json" in default_msg
    # deterministic given the same inputs (replay safety)
    assert tool_msg == d._build_initial_message(spec, structured_tool=True)


def test_dispatch_journals_running_row_before_result():
    """A `running` journal row is written AT dispatch, carrying the
    deterministic child session id for agent() calls — this is what lets the
    run UI attach the live transcript while the call is still in flight."""
    cid_a = "a" * 40 + "_0"
    cid_b = "b" * 40 + "_0"
    tasks = [agent_task(cid_a, label="A", phase="P1"), agent_task(cid_b, label="B")]
    ctx = FakeCtx(evaluator=make_evaluator(tasks, {"ok": True}))

    def complete_all(c: FakeCtx):
        c.complete_child(cid_a, {"success": True, "content": "first"})
        c.complete_child(cid_b, {"success": True, "content": "second"})

    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, [complete_all])
    assert result["success"] is True

    # One dispatch row per call, in dispatch order.
    assert [d["callId"] for d in ctx.dispatch_inputs] == [cid_a, cid_b]
    row_a = ctx.dispatch_inputs[0]
    assert row_a["sessionId"] == script_child_instance_id(ctx.instance_id, cid_a, 0)
    assert row_a["seq"] == 0
    assert row_a["spec"]["kind"] == "agent"
    assert row_a["spec"]["label"] == "A"
    assert row_a["spec"]["phase"] == "P1"

    # Ordering: each call's dispatch write precedes ANY result write (clobber
    # safety relies on this happens-before).
    log = ctx.action_log
    dispatch_i = next(
        i for i, a in enumerate(log)
        if a[0] == "activity" and a[1] == "record_script_call_dispatch" and a[2] == cid_a
    )
    result_i = next(
        i for i, a in enumerate(log)
        if a[0] == "activity" and a[1] == "record_script_call_result" and a[2] == cid_a
    )
    assert dispatch_i < result_i


def test_dispatch_journal_omits_session_id_for_workflow_calls():
    """workflow() children are executions, not sessions — their running row
    must not claim a sessionId."""
    cid = "c" * 40 + "_0"
    tasks = [workflow_task(cid, "child-wf")]
    ctx = FakeCtx(
        evaluator=make_evaluator(tasks, {"ok": True}),
        resolve_result={"success": True, "script": "return 1", "scriptSha256": "abc", "meta": {"name": "child"}},
    )

    def complete_all(c: FakeCtx):
        c.complete_child(cid, {"success": True, "returnValue": {"x": 1}})

    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, [complete_all])
    assert result["success"] is True
    assert [d["callId"] for d in ctx.dispatch_inputs] == [cid]
    assert ctx.dispatch_inputs[0]["sessionId"] is None
    assert ctx.dispatch_inputs[0]["spec"]["kind"] == "workflow"


# ---------------------------------------------------------------------------
# Contract-1.2.0 action-class dispatch (P1b): action/sleep/event kinds run
# OUTSIDE the agent slots under their own caps, behind input features.actions.
# ---------------------------------------------------------------------------
FEAT_INPUT = {"features": {"actions": True}}


def test_sleep_dispatches_timer_and_journals_done():
    cid = "a1" * 20 + "_0"
    ctx = FakeCtx(evaluator=make_evaluator([sleep_task(cid, 5)], {"ok": True}))
    result = drive(dynamic_script_workflow(ctx, base_input(**FEAT_INPUT)), ctx, [])
    assert result["success"] is True
    # A durable timer was created for the sleep (FakeCtx logs + completes it).
    assert any(a[0] == "timer" for a in ctx.action_log)
    # The drain synthesized the sleep envelope for the journal.
    raws = [i["raw"] for i in ctx.record_inputs if i["callId"] == cid]
    assert raws == [{"success": True, "sleptSeconds": 5}]


def test_action_non_ap_dispatches_execute_action_with_idempotency_key():
    cid = "b2" * 20 + "_0"
    task = action_task(cid, "workspace/command", {"command": "ls"}, label="list")
    ctx = FakeCtx(evaluator=make_evaluator([task], {"ok": True}))
    result = drive(dynamic_script_workflow(ctx, base_input(**FEAT_INPUT)), ctx, [])
    assert result["success"] is True
    assert len(ctx.execute_action_inputs) == 1
    inp = ctx.execute_action_inputs[0]
    assert inp["node"]["config"]["actionType"] == "workspace/command"
    assert inp["node"]["config"]["input"] == {"command": "ls"}
    assert inp["idempotencyKey"] == f"wf1:e1:{cid}"
    # SW parity (sw_workflow.py:4160): openshell /api/tools/* resolves a sandbox
    # by executionId = the DAPR INSTANCE id. Passing the DB id 404'd
    # workspace/write_file on dev while profile/command still worked.
    assert inp["executionId"] == ctx.instance_id
    assert inp["dbExecutionId"] == "e1"
    assert "skipIdempotencyGate" not in inp  # idempotent defaults to False
    # The activity envelope reached the journal verbatim.
    raws = [i["raw"] for i in ctx.record_inputs if i["callId"] == cid]
    assert raws == [{"success": True, "data": {"ok": 1}}]


def test_cli_workspace_action_bypasses_function_router_and_uses_helper_activity():
    cid = "b3" * 20 + "_0"
    task = action_task(
        cid,
        "workspace/command",
        {
            "cliWorkspace": True,
            "workspaceRef": "@workspace",
            "command": "git status --short",
            "cwd": "/sandbox/work",
            "timeoutMs": 1_500_000,
            "helperPod": True,
            "helperTimeoutMinutes": 120,
        },
        label="seed workspace",
    )
    ctx = FakeCtx(evaluator=make_evaluator([task], {"ok": True}))

    result = drive(dynamic_script_workflow(ctx, base_input(**FEAT_INPUT)), ctx, [])

    assert result["success"] is True
    assert ctx.execute_action_inputs == []
    assert len(ctx.cli_workspace_inputs) == 1
    payload = ctx.cli_workspace_inputs[0]
    assert payload == {
        "executionId": "e1",
        "command": "git status --short",
        "cwd": "/sandbox/work",
        "readFile": None,
        "timeoutMs": 1_500_000,
        "persistBrowserVideo": None,
        "nodeId": cid,
        "workflowId": "wf1",
        "helperPod": True,
        "helperTimeoutMinutes": 120,
        "_otel": {},
    }
    raws = [i["raw"] for i in ctx.record_inputs if i["callId"] == cid]
    assert raws == [
        {
            "success": True,
            "data": {
                "success": True,
                "result": {"exitCode": 0, "stdout": "seeded", "stderr": ""},
            },
        }
    ]


def test_action_ap_slug_dispatches_runner_child_with_pause_contract():
    """AP piece slugs dispatch as an action_runner_workflow_v1 CHILD carrying
    the SW AP durability contract (raiseOnRetryable + content-addressed
    idempotencyKey + journal context for the WEBHOOK pause marker)."""
    cid = "c3" * 20 + "_0"
    task = action_task(cid, "google-sheets/append_row", {"row": 1})
    ctx = FakeCtx(evaluator=make_evaluator([task], {"ok": True}))

    def complete_runner(c: FakeCtx):
        c.complete_child(cid, {"success": True, "data": {"appended": True}})

    result = drive(
        dynamic_script_workflow(ctx, base_input(**FEAT_INPUT)), ctx, [complete_runner]
    )
    assert result["success"] is True
    assert len([a for a in ctx.action_log if a[0] == "child"]) == 1
    iid = script_child_instance_id(ctx.instance_id, cid, 0)
    child_input = ctx.child_inputs[iid]
    assert child_input["activityInput"]["raiseOnRetryable"] is True
    assert child_input["activityInput"]["idempotencyKey"] == f"wf1:e1:{cid}"
    assert child_input["journal"]["callId"] == cid
    raws = [i["raw"] for i in ctx.record_inputs if i["callId"] == cid]
    assert raws == [{"success": True, "data": {"appended": True}}]


@pytest.mark.parametrize(
    "slug", ["preview/environment-launch", "dev/preview-promote"]
)
def test_privileged_preview_action_dispatches_retrying_runner_child(slug):
    cid = "d4" * 20 + "_0"
    task = action_task(cid, slug, {"environmentName": "feature-one"})
    ctx = FakeCtx(evaluator=make_evaluator([task], {"ok": True}))

    def complete_runner(c: FakeCtx):
        c.complete_child(cid, {"success": True, "data": {"ok": True}})

    result = drive(
        dynamic_script_workflow(ctx, base_input(**FEAT_INPUT)), ctx, [complete_runner]
    )
    assert result["success"] is True
    iid = script_child_instance_id(ctx.instance_id, cid, 0)
    child_input = ctx.child_inputs[iid]
    assert child_input["activityInput"]["raiseOnRetryable"] is True
    assert child_input["activityInput"]["idempotencyKey"] == f"wf1:e1:{cid}"
    assert child_input["journal"]["callId"] == cid


def test_privileged_preview_launch_dispatch_preserves_exact_action_input():
    cid = "d5" * 20 + "_0"
    launch_input = {
        "environmentName": "feature-one",
        "services": ["workflow-builder"],
        "ttlHours": 8,
        "retainAfterCompletion": False,
    }
    task = action_task(cid, "preview/environment-launch", launch_input)
    ctx = FakeCtx(evaluator=make_evaluator([task], {"ok": True}))

    def complete_runner(c: FakeCtx):
        c.complete_child(cid, {"success": True, "data": {"ok": True}})

    result = drive(
        dynamic_script_workflow(ctx, base_input(**FEAT_INPUT)), ctx, [complete_runner]
    )

    assert result["success"] is True
    child_input = ctx.child_inputs[script_child_instance_id(ctx.instance_id, cid, 0)]
    config = child_input["activityInput"]["node"]["config"]
    assert config == {
        "actionType": "preview/environment-launch",
        "input": launch_input,
    }


def test_action_crawl_async_journals_clear_dispatch_error():
    cid = "e7" * 20 + "_0"
    task = action_task(cid, "web/crawl.async", {"url": "https://x"})
    ctx = FakeCtx(evaluator=make_evaluator([task], {"ok": True}))
    result = drive(dynamic_script_workflow(ctx, base_input(**FEAT_INPUT)), ctx, [])
    assert result["success"] is True
    raws = [i["raw"] for i in ctx.record_inputs if i["callId"] == cid]
    assert len(raws) == 1 and raws[0]["success"] is False
    assert "web/crawl" in raws[0]["error"]


# ---------------------------------------------------------------------------
# action_runner_workflow_v1: BEGIN -> (pause -> RESUME)* -> final result.
# ---------------------------------------------------------------------------
def test_action_runner_webhook_pause_marks_journal_and_resumes():
    from workflows.action_runner_workflow import action_runner_workflow

    ctx = FakeCtx(evaluator=make_evaluator([], {"ok": True}), instance_id="runner-1")
    ctx.execute_action_results = [
        {"success": True, "pause": {"type": "WEBHOOK", "requestId": "req-42"}},
        {"success": True, "data": {"resumed": True}},
    ]
    gen = action_runner_workflow(
        ctx,
        {
            "activityInput": {"node": {"id": "c1"}, "raiseOnRetryable": True},
            "journal": {"executionId": "e1", "callId": "c1", "seq": 3, "spec": {"kind": "action"}},
        },
    )
    send = None
    result = None
    guard = 0
    while True:
        guard += 1
        assert guard < 50, "runaway runner loop"
        try:
            task = gen.send(send)
        except StopIteration as exc:
            result = exc.value
            break
        if not task.is_complete:
            # The WEBHOOK wait — deliver the callback payload.
            assert ctx.events.get("ap.resume.req-42"), "runner did not wait on ap.resume.req-42"
            task.complete({"requestId": "req-42", "body": {"approved": True}})
        send = task.get_result()

    assert result == {"success": True, "data": {"resumed": True}}
    # Pause marker journaled with the waiter instance id (ap-resume route target).
    assert len(ctx.pause_inputs) == 1
    pause = ctx.pause_inputs[0]["pause"]
    assert pause["requestId"] == "req-42" and pause["waiterInstanceId"] == "runner-1"
    # RESUME round carried the callback payload.
    assert ctx.execute_action_inputs[1]["executionType"] == "RESUME"
    assert ctx.execute_action_inputs[1]["resumePayload"]["body"] == {"approved": True}


def test_action_runner_delay_pause_uses_timer_then_resumes():
    from workflows.action_runner_workflow import action_runner_workflow

    ctx = FakeCtx(evaluator=make_evaluator([], {"ok": True}), instance_id="runner-2")
    ctx.execute_action_results = [
        {"success": True, "pause": {"type": "DELAY", "delaySeconds": 30}},
        {"success": True, "data": {"done": 1}},
    ]
    gen = action_runner_workflow(
        ctx, {"activityInput": {"node": {"id": "c2"}}, "journal": {}}
    )
    send = None
    result = None
    guard = 0
    while True:
        guard += 1
        assert guard < 50, "runaway runner loop"
        try:
            task = gen.send(send)
        except StopIteration as exc:
            result = exc.value
            break
        assert task.is_complete, "runner yielded a pending task the test did not arm"
        send = task.get_result()
    assert result == {"success": True, "data": {"done": 1}}
    assert any(a[0] == "timer" for a in ctx.action_log)
    assert ctx.pause_inputs == []  # DELAY needs no resume-target marker


def test_event_kind_dispatches_wait_event_child_and_resolves_payload():
    """approve()/waitForEvent() dispatches a wait_event_workflow_v1 child on a
    per-callId event name; the delivered payload journals as the gate result."""
    cid = "d4" * 20 + "_0"
    ctx = FakeCtx(evaluator=make_evaluator([event_task(cid)], {"ok": True}))

    def approve_gate(c: FakeCtx):
        c.complete_child(cid, {"approved": True, "approvedBy": "u1"})

    result = drive(
        dynamic_script_workflow(ctx, base_input(**FEAT_INPUT)), ctx, [approve_gate]
    )
    assert result["success"] is True
    iid = script_child_instance_id(ctx.instance_id, cid, 0)
    child_input = ctx.child_inputs[iid]
    assert child_input["eventName"] == f"script.event.{cid}"
    assert child_input["logicalName"] == "approval"
    assert child_input["journal"]["callId"] == cid
    raws = [i["raw"] for i in ctx.record_inputs if i["callId"] == cid]
    assert raws == [{"approved": True, "approvedBy": "u1"}]


def test_wait_event_workflow_marks_waiter_and_resolves_timeout():
    """The gate child journals its waiter marker (approve-route target), logs
    the approval-request row, and RESOLVES {timedOut:true} on timeout."""
    from workflows.wait_event_workflow import wait_event_workflow

    ctx = FakeCtx(evaluator=make_evaluator([], {"ok": True}), instance_id="gate-1")
    gen = wait_event_workflow(
        ctx,
        {
            "eventName": "script.event.abc_0",
            "logicalName": "approval",
            "timeoutMinutes": 60,
            "journal": {"executionId": "e1", "callId": "abc_0", "seq": 1, "spec": {"kind": "event"}},
        },
    )
    send = None
    result = None
    guard = 0
    while True:
        guard += 1
        assert guard < 50, "runaway gate loop"
        try:
            task = gen.send(send)
        except StopIteration as exc:
            result = exc.value
            break
        if not task.is_complete:
            # The external-event wait: simulate a TIMEOUT by throwing into the
            # generator the way durabletask surfaces expired waits.
            assert ctx.events.get("script.event.abc_0"), "gate did not wait on its event"
            try:
                gen.throw(TimeoutError())
            except StopIteration as exc:
                result = exc.value
                break
            continue
        send = task.get_result()

    assert result == {"timedOut": True}
    # Waiter marker journaled (approve route target).
    assert len(ctx.pause_inputs) == 1
    pause = ctx.pause_inputs[0]["pause"]
    assert pause["type"] == "EVENT" and pause["waiterInstanceId"] == "gate-1"
    assert pause["eventName"] == "script.event.abc_0"
    # Approval request + timeout rows logged.
    logged = [a[1] for a in ctx.action_log if a[0] == "activity"]
    assert "log_approval_request" in logged and "log_approval_timeout" in logged


def test_action_kinds_without_features_flag_hit_skew_guard():
    """No input features.actions -> action-class kinds are outside allowed_kinds
    and must journal the unknown-kind dispatch error (never dispatch)."""
    cid = "e5" * 20 + "_0"
    ctx = FakeCtx(evaluator=make_evaluator([sleep_task(cid, 5)], {"ok": True}))
    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, [])
    assert result["success"] is True
    assert not any(a[0] == "timer" for a in ctx.action_log if "usage" not in str(a))
    raws = [i["raw"] for i in ctx.record_inputs if i["callId"] == cid]
    assert len(raws) == 1 and raws[0]["success"] is False
    assert "unknown task kind" in raws[0]["error"]


def test_actions_do_not_consume_agent_concurrency_slots():
    """5 agents saturate maxConcurrentAgents; an action + a sleep must still
    dispatch in the SAME round (separate maxConcurrentActions pool)."""
    agents = [agent_task(f"{c * 40}_0", label=c) for c in ("a", "b", "c", "d", "e")]
    act = action_task("f6" * 20 + "_0", "workspace/command", {"command": "true"})
    slp = sleep_task("a7" * 20 + "_0", 1)
    ctx = FakeCtx(evaluator=make_evaluator([*agents, act, slp], {"ok": True}))

    def complete_agents(c: FakeCtx):
        for a in ("a", "b", "c", "d", "e"):
            c.complete_child(f"{a * 40}_0", {"success": True, "content": a})

    result = drive(
        dynamic_script_workflow(ctx, base_input(**FEAT_INPUT)), ctx, [complete_agents]
    )
    assert result["success"] is True
    # The action activity ran, and all 5 agents were dispatched as children —
    # neither pool starved the other.
    assert len(ctx.execute_action_inputs) == 1
    assert len([a for a in ctx.action_log if a[0] == "child"]) == 5


def test_action_lifetime_cap_journals_dispatch_error():
    t1 = sleep_task("a8" * 20 + "_0", 1)
    t2 = sleep_task("b9" * 20 + "_0", 2)
    ctx = FakeCtx(evaluator=make_evaluator([t1, t2], {"ok": True}))
    inp = base_input(**FEAT_INPUT)
    inp["limits"] = {**inp["limits"], "maxLifetimeActions": 1}
    result = drive(dynamic_script_workflow(ctx, inp), ctx, [])
    assert result["success"] is True
    raws = {i["callId"]: i["raw"] for i in ctx.record_inputs}
    outcomes = sorted(str(r.get("error") or "ok") for r in raws.values())
    assert any("lifetime cap" in o for o in outcomes)
    assert any(o == "ok" or "sleptSeconds" in str(raws) for o in outcomes)


def test_call_site_position_threads_to_journal_rows():
    """Contract-1.2.0 tasks[].position rides the spec into every journal write
    (dispatch + result) as callSite — the canvas overlay's join key."""
    cid = "f0" * 20 + "_0"
    task = agent_task(cid, prompt="hi", label="pos")
    task["position"] = {"line": 7, "column": 23}
    ctx = FakeCtx(evaluator=make_evaluator([task], {"ok": True}))

    def complete(c: FakeCtx):
        c.complete_child(cid, {"success": True, "content": "done"})

    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, [complete])
    assert result["success"] is True
    d_spec = next(i["spec"] for i in ctx.dispatch_inputs if i["callId"] == cid)
    r_spec = next(i["spec"] for i in ctx.record_inputs if i["callId"] == cid)
    assert d_spec["callSite"] == {"line": 7, "column": 23}
    assert r_spec["callSite"] == {"line": 7, "column": 23}


def test_dev_preview_activation_routes_to_runner_child_with_durable_poll():
    """Blocker B1 (cutover P3): action('dev/preview', {mode:'preview-native',
    services:[…]}) is NOT single-shot — it must dispatch through the runner
    child, which reuses the SW interpreter's durable activation poll."""
    cid = "b1" * 20 + "_0"
    task = action_task(
        cid,
        "dev/preview",
        {
            "mode": "preview-native",
            "adopt": True,
            "services": ["workflow-builder"],
            "activationPollSeconds": 2,
        },
        label="dev_preview",
    )
    ctx = FakeCtx(evaluator=make_evaluator([task], {"ok": True}))

    def complete_runner(c: FakeCtx):
        c.complete_child(cid, {"success": True, "data": {"ready": True}})

    result = drive(
        dynamic_script_workflow(ctx, base_input(**FEAT_INPUT)), ctx, [complete_runner]
    )
    assert result["success"] is True
    # Dispatched as a CHILD (the runner), not a bare activity.
    assert len([a for a in ctx.action_log if a[0] == "child"]) == 1
    assert ctx.execute_action_inputs == []
    iid = script_child_instance_id(ctx.instance_id, cid, 0)
    child_input = ctx.child_inputs[iid]
    cfg = child_input["activityInput"]["node"]["config"]
    assert cfg["actionType"] == "dev/preview"
    assert cfg["input"]["mode"] == "preview-native"
    # AP-only retry semantics must NOT be stamped on an activation call.
    assert "raiseOnRetryable" not in child_input["activityInput"]


def test_retained_workspace_profile_records_workspace_session():
    """SW parity: a retained (keepAfterRun) workspace/profile action records a
    workflow_workspace_sessions row via persist_workspace_session — the
    runtime-preview page resolves an execution's sandbox through it."""
    cid = "c1" * 20 + "_0"
    task = action_task(
        cid,
        "workspace/profile",
        {"name": "x", "rootPath": "/sandbox", "keepAfterRun": True},
        label="workspace_profile",
    )
    ctx = FakeCtx(evaluator=make_evaluator([task], {"ok": True}))
    ctx.execute_action_results = [
        {"success": True, "result": {"workspaceRef": "ws-1", "rootPath": "/sandbox"}}
    ]
    result = drive(dynamic_script_workflow(ctx, base_input(**FEAT_INPUT)), ctx, [])
    assert result["success"] is True
    assert len(ctx.persist_workspace_inputs) == 1
    payload = ctx.persist_workspace_inputs[0]
    assert payload["workflowExecutionId"] == "e1"
    assert payload["keepAfterRun"] is True
    assert payload["taskName"] == "workspace_profile"
    assert payload["result"]["result"]["workspaceRef"] == "ws-1"


def test_transient_workspace_profile_skips_session_recording():
    """keepAfterRun absent/false → NO workspace-session row (matches SW)."""
    cid = "c2" * 20 + "_0"
    task = action_task(
        cid, "workspace/profile", {"name": "x", "rootPath": "/sandbox"}, label="p"
    )
    ctx = FakeCtx(evaluator=make_evaluator([task], {"ok": True}))
    ctx.execute_action_results = [{"success": True, "result": {"workspaceRef": "ws-2"}}]
    result = drive(dynamic_script_workflow(ctx, base_input(**FEAT_INPUT)), ctx, [])
    assert result["success"] is True
    assert ctx.persist_workspace_inputs == []


# ---------------------------------------------------------------------------
# Teardown headroom (preview-lifecycle hardening 1b/1c): compensation-slug
# actions still dispatch past the lifetime action cap (their own small budget)
# and cancel runs ONE bounded compensation evaluation round before persisting
# terminal 'cancelled'.
# ---------------------------------------------------------------------------
def test_cap_exhaustion_teardown_compensation_slug_still_dispatches():
    """cap-exhaustion-teardown: with the lifetime action cap exhausted, a
    non-compensation action journals the cap dispatchError while a
    compensation-slug action (preview/environment-teardown) still dispatches
    from its own reserved budget."""
    act1 = action_task("a1" * 20 + "_0", "workspace/command", {"command": "true"})
    act2 = action_task("b2" * 20 + "_0", "workspace/command", {"command": "ls"})
    teardown = action_task(
        "c3" * 20 + "_0",
        "preview/environment-teardown",
        {"environmentName": "feature-one"},
        label="teardown",
    )
    ctx = FakeCtx(evaluator=make_evaluator([act1, act2, teardown], {"ok": True}))
    inp = base_input(**FEAT_INPUT)
    inp["limits"] = {**inp["limits"], "maxLifetimeActions": 1}

    def complete_teardown(c: FakeCtx):
        c.complete_child("c3" * 20 + "_0", {"success": True, "data": {"tornDown": True}})

    result = drive(dynamic_script_workflow(ctx, inp), ctx, [complete_teardown])
    assert result["success"] is True
    raws = {i["callId"]: i["raw"] for i in ctx.record_inputs}
    # act1 consumed the whole lifetime budget; act2 hit the cap...
    assert "action lifetime cap reached" in raws["b2" * 20 + "_0"]["error"]
    # ...while the teardown slug still dispatched (runner child) + succeeded.
    iid = script_child_instance_id(ctx.instance_id, "c3" * 20 + "_0", 0)
    assert iid in ctx.children
    assert raws["c3" * 20 + "_0"] == {"success": True, "data": {"tornDown": True}}


def test_compensation_budget_caps_runaway_teardown_calls(monkeypatch):
    """Compensation slugs bypass the lifetime cap but carry their OWN budget —
    a runaway teardown/status loop still terminates with a dispatchError."""
    import workflows.dynamic_script_workflow as w

    monkeypatch.setattr(w, "DEFAULT_MAX_COMPENSATION_ACTIONS", 1)
    t1 = action_task(
        "d1" * 20 + "_0", "preview/environment-teardown", {"environmentName": "x"}
    )
    t2 = action_task(
        "e2" * 20 + "_0", "preview/environment-teardown-status", {"ticket": "t"}
    )
    ctx = FakeCtx(evaluator=make_evaluator([t1, t2], {"ok": True}))

    def complete_first(c: FakeCtx):
        c.complete_child("d1" * 20 + "_0", {"success": True, "data": {"ok": True}})

    result = drive(
        dynamic_script_workflow(ctx, base_input(**FEAT_INPUT)), ctx, [complete_first]
    )
    assert result["success"] is True
    raws = {i["callId"]: i["raw"] for i in ctx.record_inputs}
    assert raws["d1" * 20 + "_0"]["success"] is True
    assert "compensation action budget reached" in raws["e2" * 20 + "_0"]["error"]


def test_cancel_compensation_round_dispatches_teardown_then_persists_cancelled():
    """cancel-compensation: workflow.cancel triggers exactly ONE compensation
    evaluation round; the script's finally-block teardown (compensation slug)
    dispatches and journals, a non-compensation call gets the dispatchError,
    and the run still persists terminal 'cancelled'."""
    agent_cid = "a" * 40 + "_0"
    teardown_cid = "f1" * 20 + "_0"
    extra_agent_cid = "b" * 40 + "_0"
    teardown = action_task(
        teardown_cid, "preview/environment-teardown", {"environmentName": "feature-one"}
    )

    def evaluator(input_data):
        known = set(input_data.get("knownCallIds") or [])
        if agent_cid not in known:
            return plan_need([agent_task(agent_cid, label="main")])
        # The finally block: teardown + one non-compensation late call.
        remaining = [
            t
            for t in (teardown, agent_task(extra_agent_cid, label="late"))
            if t["callId"] not in known
        ]
        if not remaining:
            return plan_done({"ok": True})
        return plan_need(remaining)

    ctx = FakeCtx(evaluator=evaluator)
    steps = [
        lambda c: c.fire_cancel("user stop"),
        lambda c: c.complete_child(
            teardown_cid, {"success": True, "data": {"tornDown": True}}
        ),
    ]
    result = drive(dynamic_script_workflow(ctx, base_input(**FEAT_INPUT)), ctx, steps)

    # Cancel intent wins: terminal status stays cancelled.
    assert result["success"] is False
    assert result["cancelled"] is True
    assert result["status"] == "cancelled"
    assert "user stop" in result["error"]

    raws = {i["callId"]: i["raw"] for i in ctx.record_inputs}
    # The in-flight agent call was journaled as cancelled...
    assert raws[agent_cid] == {"success": False, "cancelled": True}
    # ...the finally-block teardown dispatched (runner child) and journaled...
    iid = script_child_instance_id(ctx.instance_id, teardown_cid, 0)
    assert iid in ctx.children
    assert raws[teardown_cid] == {"success": True, "data": {"tornDown": True}}
    # ...and the non-compensation call could NOT start.
    assert raws[extra_agent_cid]["success"] is False
    assert "only compensation actions" in raws[extra_agent_cid]["error"]

    # Exactly ONE compensation evaluation round: 2 evaluates total (the main
    # round + the post-cancel round).
    evals = [
        a for a in ctx.action_log if a[0] == "activity" and a[1] == "evaluate_script"
    ]
    assert len(evals) == 2

    # The terminal persist ('cancelled') lands AFTER the teardown journal.
    log = ctx.action_log
    teardown_rec_i = next(
        i
        for i, a in enumerate(log)
        if a[0] == "activity"
        and a[1] == "record_script_call_result"
        and a[2] == teardown_cid
    )
    persist_i = next(
        i
        for i, a in enumerate(log)
        if a[0] == "activity" and a[1] == "persist_results_to_db"
    )
    assert teardown_rec_i < persist_i


def test_cancel_without_pending_compensation_stays_terminal():
    """A cancel whose compensation evaluate yields no new tasks persists
    'cancelled' without dispatching anything further."""
    cid = "a" * 40 + "_0"
    ctx = FakeCtx(evaluator=make_evaluator([agent_task(cid)], "x"))

    result = drive(
        dynamic_script_workflow(ctx, base_input(**FEAT_INPUT)),
        ctx,
        [lambda c: c.fire_cancel("stop now")],
    )
    assert result["status"] == "cancelled"
    # The lone in-flight call was journaled as cancelled; nothing else dispatched.
    raws = {i["callId"]: i["raw"] for i in ctx.record_inputs}
    assert raws[cid] == {"success": False, "cancelled": True}
    assert len([a for a in ctx.action_log if a[0] == "child"]) == 1  # the agent only


def test_terminal_custom_status_is_completed_with_progress_100():
    # The terminal emit must not be deduped away: without an explicit terminal
    # phase the payload equals the pre-terminal one (last script phase, progress
    # 0 sans estimatedAgentCalls) and runtime consumers stay on "Finalize"/0%.
    tasks = [agent_task("a" * 40 + "_0", label="A")]
    ctx = FakeCtx(evaluator=make_evaluator(tasks, {"ok": True}))

    def complete(c: FakeCtx):
        c.complete_child("a" * 40 + "_0", {"success": True, "content": "done"})

    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, [complete])
    assert result["status"] == "completed"
    assert ctx.custom_statuses, "terminal custom status must be emitted"
    final = json.loads(ctx.custom_statuses[-1])
    assert final["phase"] == "completed"
    assert final["progress"] == 100


def test_script_error_emits_failed_terminal_custom_status():
    ctx = FakeCtx(evaluator=lambda inp: plan_script_error("boom in script"))
    result = drive(dynamic_script_workflow(ctx, base_input()), ctx, [])
    assert result["status"] == "script_error"
    assert ctx.custom_statuses, "terminal custom status must be emitted"
    final = json.loads(ctx.custom_statuses[-1])
    assert final["phase"] == "failed"
