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

    # -- deterministic side effects captured for assertions ----------------
    def set_custom_status(self, status: str) -> None:
        self.custom_statuses.append(status)

    def wait_for_external_event(self, name: str) -> CompletableTask:
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

    def create_timer(self, fire_after) -> CompletableTask:
        # Usage-settle gate (budget-bounded runs): fires immediately in tests.
        self.action_log.append(("timer", str(fire_after)))
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
        return ""

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
            assert task.get("kind") in {"agent", "workflow"}
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


def test_native_structured_gated_to_dapr_agent_py(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    # non-dapr runtime (e.g. claude-agent-py, Anthropic-only) -> no routing/stamp
    cfg = d._build_agent_config({"schema": schema}, {"model": "zai/glm-5.2"}, "claude-agent-py", {})
    assert "responseJsonSchema" not in cfg
    assert "modelSpec" not in cfg


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
# StructuredOutput TOOL mode (Tier-2 upgrade): a schema'd call resolved to GLM
# stamps structuredOutputMode=tool and gets the tool-flavored output contract.
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


def test_default_schema_routing_is_glm_tool_mode(monkeypatch):
    import workflows.script_agent_dispatch as d

    monkeypatch.delenv("DYNAMIC_SCRIPT_NATIVE_STRUCTURED_OUTPUT", raising=False)
    monkeypatch.delenv("DYNAMIC_SCRIPT_STRUCTURED_TOOL", raising=False)
    monkeypatch.delenv("DYNAMIC_SCRIPT_STRUCTURED_MODEL", raising=False)
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    # schema'd call with no explicit model: default is GLM + StructuredOutput
    # tool (42/42 spike; keeps schema'd calls on the cheap default provider)
    cfg = d._build_agent_config({"schema": schema}, {"model": "zai/glm-5.2"}, "dapr-agent-py", {})
    assert cfg["modelSpec"] == "zai/glm-5.2"
    assert cfg["structuredOutputMode"] == "tool"
    assert cfg["responseJsonSchema"] == schema


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
