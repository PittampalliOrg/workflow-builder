from __future__ import annotations

import importlib.util
import sys
import types
from contextlib import nullcontext
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if "dapr" not in sys.modules:
    dapr_module = types.ModuleType("dapr")
    ext_module = types.ModuleType("dapr.ext")
    workflow_module = types.ModuleType("dapr.ext.workflow")
    clients_module = types.ModuleType("dapr.clients")

    class _FakeWorkflowRuntime:
        def activity(self, _name=None):
            def decorator(fn):
                return fn

            return decorator

        def workflow(self, _name=None):
            def decorator(fn):
                return fn

            return decorator

    class _FakeDaprWorkflowClient:
        def raise_workflow_event(self, *args, **kwargs):
            return None

    class _FakeDaprClient:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def publish_event(self, **_kwargs):
            return None

    workflow_module.WorkflowRuntime = _FakeWorkflowRuntime
    workflow_module.DaprWorkflowContext = object
    workflow_module.DaprWorkflowClient = _FakeDaprWorkflowClient
    workflow_module.when_any = lambda tasks: {"kind": "when_any", "tasks": tasks}
    clients_module.DaprClient = _FakeDaprClient

    sys.modules["dapr"] = dapr_module
    sys.modules["dapr.ext"] = ext_module
    sys.modules["dapr.ext.workflow"] = workflow_module
    sys.modules["dapr.clients"] = clients_module

if "celpy" not in sys.modules:
    celpy_module = types.ModuleType("celpy")
    celpy_adapter_module = types.ModuleType("celpy.adapter")

    class _FakeProgram:
        def evaluate(self, _activation):
            return False

    class _FakeEnvironment:
        def compile(self, expression):
            return expression

        def program(self, _ast):
            return _FakeProgram()

    celpy_module.Environment = _FakeEnvironment
    celpy_adapter_module.json_to_cel = lambda value: value

    sys.modules["celpy"] = celpy_module
    sys.modules["celpy.adapter"] = celpy_adapter_module

if "psycopg2" not in sys.modules:
    psycopg2_module = types.ModuleType("psycopg2")
    psycopg2_module.connect = lambda *_args, **_kwargs: None
    sys.modules["psycopg2"] = psycopg2_module

if "requests" not in sys.modules:
    requests_module = types.ModuleType("requests")
    requests_module.post = lambda *_args, **_kwargs: None
    requests_module.get = lambda *_args, **_kwargs: None
    requests_module.request = lambda *_args, **_kwargs: None
    sys.modules["requests"] = requests_module


def _load_module(name: str, relative_path: str):
    module_path = ROOT / relative_path
    spec = importlib.util.spec_from_file_location(name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load module from {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DYNAMIC = _load_module("dynamic_workflow", "workflows/dynamic_workflow.py")
PUBLISH_EVENT = _load_module("publish_event", "activities/publish_event.py")
TRACK_AGENT_RUN = _load_module("track_agent_run", "activities/track_agent_run.py")


class FakeEvent:
    def __init__(self, result=None) -> None:
        self._result = result or {}

    def get_result(self):
        return self._result


class FakeCtx:
    def __init__(self) -> None:
        self.custom_statuses: list[str] = []
        self.continue_payload = None
        self._event = FakeEvent({"approved": True, "reason": "ship it", "respondedBy": "vinod"})
        self._timer = object()

    def call_activity(self, fn, input=None):
        return {"kind": "call_activity", "name": fn.__name__, "input": input}

    def set_custom_status(self, payload: str):
        self.custom_statuses.append(payload)

    def wait_for_external_event(self, _name: str):
        return self._event

    def create_timer(self, _delta):
        return self._timer

    def continue_as_new(self, payload):
        self.continue_payload = payload


class FakeCursor:
    def __init__(self) -> None:
        self.executions: list[tuple[str, tuple[object, ...]]] = []

    def execute(self, sql: str, params: tuple[object, ...]) -> None:
        self.executions.append((" ".join(sql.split()), params))

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None


class FakeConnection:
    def __init__(self) -> None:
        self.cursor_instance = FakeCursor()
        self.committed = False

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.committed = True

    def close(self):
        return None


def test_process_approval_gate_persists_phase_and_resumes_on_event(monkeypatch):
    ctx = FakeCtx()
    monkeypatch.setattr(DYNAMIC, "logger", type("Logger", (), {"info": lambda *args, **kwargs: None})())
    monkeypatch.setattr(DYNAMIC.wf, "when_any", lambda tasks: {"kind": "when_any", "tasks": tasks})

    node = {
        "id": "approve-node",
        "label": "Approve Plan",
        "config": {"eventName": "plan_approval", "timeoutMinutes": 5},
    }

    workflow = DYNAMIC.process_approval_gate(
        ctx,
        node,
        execution_id="exec-1",
        workflow_id="wf-1",
        db_execution_id="db-exec-1",
        otel_ctx={"traceId": "trace-123"},
    )

    first = next(workflow)
    assert first["name"] == "log_approval_request"
    second = workflow.send(None)
    assert second["name"] == "publish_phase_changed"
    waiting = workflow.send(None)
    assert waiting["kind"] == "when_any"
    response_log = workflow.send(ctx._event)
    assert response_log["name"] == "log_approval_response"
    with pytest.raises(StopIteration) as stop:
        workflow.send(None)
    result = stop.value.value

    assert result["approved"] is True
    assert result["respondedBy"] == "vinod"
    assert "awaiting_approval" in ctx.custom_statuses[0]
    assert "plan_approval" in ctx.custom_statuses[0]


def test_process_approval_gate_rejects_anonymous_approval(monkeypatch):
    ctx = FakeCtx()
    ctx._event = FakeEvent({"approved": True, "reason": "Approved"})
    monkeypatch.setattr(DYNAMIC, "logger", type("Logger", (), {"info": lambda *args, **kwargs: None, "warning": lambda *args, **kwargs: None})())
    monkeypatch.setattr(DYNAMIC.wf, "when_any", lambda tasks: {"kind": "when_any", "tasks": tasks})

    node = {
        "id": "approve-node",
        "label": "Approve Plan",
        "config": {"eventName": "plan_approval", "timeoutMinutes": 5},
    }

    workflow = DYNAMIC.process_approval_gate(
        ctx,
        node,
        execution_id="exec-1",
        workflow_id="wf-1",
        db_execution_id="db-exec-1",
        otel_ctx={"traceId": "trace-123"},
    )

    next(workflow)
    workflow.send(None)
    workflow.send(None)
    response_log = workflow.send(ctx._event)
    assert response_log["name"] == "log_approval_response"

    with pytest.raises(StopIteration) as stop:
        workflow.send(None)
    result = stop.value.value

    assert result["approved"] is False
    assert result["reason"] == "Approval response missing actor metadata"
    assert result["respondedBy"] is None


def test_continue_as_new_captures_runtime_checkpoint():
    ctx = FakeCtx()

    DYNAMIC._continue_dynamic_workflow_as_new(
        ctx,
        {"triggerData": {"foo": "bar"}},
        next_node_index=3,
        state_vars={"flag": True},
        node_outputs={"trigger": {"data": {"foo": "bar"}}},
        completed_node_ids={"a", "b"},
        loop_iterations={"loop-a": 2},
        node_execution_counts={"node-x": 4},
        skipped_node_ids={"skip-a"},
        skipped_reason_by_node_id={"skip-a": {"reason": "condition_false"}},
        continue_as_new_count=1,
    )

    assert ctx.continue_payload is not None
    runtime = ctx.continue_payload["_runtime"]
    assert runtime["nextNodeIndex"] == 3
    assert runtime["completedNodeExecutionsSinceCheckpoint"] == 0
    assert runtime["continueAsNewCount"] == 2
    assert runtime["loopIterations"] == {"loop-a": 2}


def test_build_planning_prompt_preserves_goal_but_forbids_mutation():
    prompt = DYNAMIC._build_planning_prompt(
        task_prompt=(
            "Create scripts/generate-report.sh and docs/report.md, then run the verification commands."
        ),
        cwd="/workspace/repo",
        expected_output="A verified Python utility plus plan artifact.",
        verify_commands="python -m py_compile scripts/workflow_builder_demo_report.py",
        stop_condition="The new Python utility exists and verification commands pass.",
    )

    assert "PLANNING MODE" in prompt
    assert "Create scripts/generate-report.sh" in prompt
    assert "Do not create directories" in prompt
    assert "Do not create directories, do not write or edit files" in prompt
    assert "python -m py_compile scripts/workflow_builder_demo_report.py" in prompt
    assert "stop condition" not in prompt.lower() or "Plan toward this stop condition" in prompt


def test_track_agent_run_completed_keeps_terminal_status_when_event_published(monkeypatch):
    fake_connection = FakeConnection()
    monkeypatch.setattr(TRACK_AGENT_RUN, "_get_database_url", lambda: "postgres://example")
    monkeypatch.setattr(TRACK_AGENT_RUN.psycopg2, "connect", lambda _url: fake_connection)
    monkeypatch.setattr(TRACK_AGENT_RUN, "start_activity_span", lambda *_args, **_kwargs: nullcontext())

    result = TRACK_AGENT_RUN.track_agent_run_completed(
        None,
        {
            "id": "run-1",
            "success": True,
            "result": {"ok": True},
            "eventPublished": True,
        },
    )

    assert result["success"] is True
    assert fake_connection.committed is True
    _, params = fake_connection.cursor_instance.executions[0]
    assert params[0] == "completed"
    assert params[3] is True


def test_publish_phase_changed_persists_execution_phase_before_publish(monkeypatch):
    calls: list[tuple[str, object, object]] = []

    monkeypatch.setattr(
        PUBLISH_EVENT,
        "_persist_execution_phase",
        lambda execution_id, phase, progress: calls.append(
            ("persist", execution_id, {"phase": phase, "progress": progress})
        ),
    )
    monkeypatch.setattr(
        PUBLISH_EVENT,
        "publish_event",
        lambda _ctx, payload: {
            "success": True,
            "eventType": payload["eventType"],
            "phase": payload["data"]["phase"],
        },
    )

    result = PUBLISH_EVENT.publish_phase_changed(
        None,
        {
            "workflowId": "wf-1",
            "executionId": "exec-1",
            "phase": "awaiting_approval",
            "progress": 50,
            "message": "Waiting for approval",
        },
    )

    assert calls == [("persist", "exec-1", {"phase": "awaiting_approval", "progress": 50})]
    assert result["success"] is True
    assert result["phase"] == "awaiting_approval"
