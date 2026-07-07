"""Tests for the agent-spawnable Workflow tool (src/tools/workflow_script):
executor guards + child-workflow scheduling, the pure bridge helpers, and the
spec-carrying description."""
from __future__ import annotations

import os
import sys

import pytest

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

from src.tools.workflow_script.workflow_tool import (  # noqa: E402
    WorkflowArgs,
    build_start_request,
    build_workflow_script_tool,
    classify_poll,
    digest_output,
    _schedule_workflow_script,
)
from src.tools.workflow_script.prompt import (  # noqa: E402
    get_workflow_tool_description,
)


class FakeCtx:
    def __init__(self, instance_id: str = "session-abc__turn__1"):
        self.instance_id = instance_id
        self.calls: list[dict] = []

    def call_child_workflow(self, workflow, input, instance_id):
        record = {"workflow": workflow, "input": input, "instance_id": instance_id}
        self.calls.append(record)
        return record  # stands in for the Dapr Task


# ---------------------------------------------------------------------------
# Executor
# ---------------------------------------------------------------------------
def test_executor_schedules_bridge_with_generated_execution_id():
    ctx = FakeCtx()
    task = _schedule_workflow_script(
        ctx,
        script="export const meta = { name: 't' }\nreturn 1",
        args={"q": "x"},
        budgetTotal=50_000,
        _source_agent="agent-1",
    )
    assert task["workflow"] == "run_workflow_script_bridge"
    payload = task["input"]
    assert payload["executionId"].startswith("wfs")
    assert len(payload["executionId"]) == 21
    assert task["instance_id"] == f"{payload['executionId']}:wfsbridge"
    assert payload["attachOnly"] is False
    assert payload["hasArgs"] is True
    assert payload["args"] == {"q": "x"}
    assert payload["budgetTotal"] == 50_000
    assert payload["parentInstanceId"] == "session-abc__turn__1"
    assert payload["timeoutMinutes"] == 30


def test_executor_reattaches_to_existing_execution():
    ctx = FakeCtx()
    task = _schedule_workflow_script(ctx, executionId="wfs123456789012345678")
    payload = task["input"]
    assert payload["executionId"] == "wfs123456789012345678"
    assert payload["attachOnly"] is True
    assert payload["script"] is None and payload["workflowName"] is None


def test_executor_requires_exactly_one_input():
    ctx = FakeCtx()
    with pytest.raises(ValueError):
        _schedule_workflow_script(ctx)
    with pytest.raises(ValueError):
        _schedule_workflow_script(
            ctx, script="export const meta={name:'x'}", workflowName="saved"
        )


def test_executor_refuses_script_spawned_sessions():
    # Depth-1 recursion guard: an agent that is ITSELF a workflow's child
    # (instance id carries the durable-script marker) cannot spawn workflows.
    ctx = FakeCtx(
        instance_id="dsw-x-exec-E1__durable-script__abcdef0123456789__run__0"
    )
    with pytest.raises(RuntimeError, match="one level"):
        _schedule_workflow_script(ctx, script="export const meta={name:'x'}")


def test_executor_omits_args_when_absent():
    ctx = FakeCtx()
    task = _schedule_workflow_script(ctx, workflowName="deep-research")
    payload = task["input"]
    assert payload["hasArgs"] is False
    assert payload["workflowName"] == "deep-research"


def test_executor_clamps_timeout():
    ctx = FakeCtx()
    hi = _schedule_workflow_script(
        ctx, workflowName="x", timeoutMinutes=999
    )["input"]["timeoutMinutes"]
    lo = _schedule_workflow_script(
        ctx, workflowName="x", timeoutMinutes=0
    )["input"]["timeoutMinutes"]
    assert hi == 120 and lo == 1


# ---------------------------------------------------------------------------
# Bridge helpers (pure)
# ---------------------------------------------------------------------------
def test_build_start_request_inline_script():
    path, body = build_start_request(
        {
            "executionId": "wfs1",
            "script": "export const meta={name:'x'}",
            "hasArgs": True,
            "args": [1, 2],
            "budgetTotal": 1000,
        }
    )
    assert path == "api/internal/agent/workflows/execute-script"
    assert body == {
        "executionId": "wfs1",
        "budgetTotal": 1000,
        "script": "export const meta={name:'x'}",
        "args": [1, 2],
    }


def test_build_start_request_saved_workflow_omits_absent_args():
    path, body = build_start_request(
        {"executionId": "wfs2", "workflowName": "deep-research", "hasArgs": False}
    )
    assert path == "api/internal/agent/workflows/execute"
    assert body == {"executionId": "wfs2", "workflowName": "deep-research"}


def test_classify_poll_terminal_with_nested_db_output():
    poll = classify_poll(
        {
            "status": "success",
            "execution": {
                "status": "success",
                "output": {"outputs": {"returnValue": {"ok": True}}},
            },
            "runtime": None,
        }
    )
    assert poll["terminal"] is True
    assert poll["status"] == "success"
    assert poll["output"] == {"ok": True}


def test_classify_poll_prefers_live_runtime_outputs():
    poll = classify_poll(
        {
            "status": "success",
            "execution": {"output": {"outputs": {"returnValue": "stale"}}},
            "runtime": {"outputs": {"returnValue": "fresh"}, "phase": "Report"},
        }
    )
    assert poll["output"] == "fresh"
    assert poll["phase"] == "Report"


def test_classify_poll_non_terminal():
    poll = classify_poll({"status": "running", "execution": {"status": "running"}})
    assert poll["terminal"] is False


def test_digest_output_caps_runaway_return_values():
    small = {"ok": True}
    assert digest_output(small) == small
    huge = "x" * 50_000
    capped = digest_output(huge, max_chars=1000)
    assert capped["truncated"] is True
    assert capped["totalChars"] > 1000
    assert len(capped["preview"]) == 1000


# ---------------------------------------------------------------------------
# Tool surface
# ---------------------------------------------------------------------------
def test_tool_builds_with_spec_carrying_description():
    tool = build_workflow_script_tool()
    assert tool.name == "Workflow"
    description = get_workflow_tool_description()
    # The description IS the spec injection — anchor the load-bearing parts.
    for marker in (
        "export const meta",
        "agent(prompt, opts?)",
        "pipeline(items",
        "parallel(thunks)",
        "Date.now()",
        "opts.schema",
        "exactly ONE of",
        "ONE level only",
    ):
        assert marker in description, marker


def test_args_model_round_trip():
    parsed = WorkflowArgs.model_validate(
        {"script": "export const meta={name:'x'}", "budgetTotal": 5}
    )
    assert parsed.script and parsed.budgetTotal == 5
    assert parsed.workflowName is None and parsed.executionId is None
