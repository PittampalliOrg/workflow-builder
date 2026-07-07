"""Workflow tool — agent-spawnable dynamic-script workflows (Approach B).

The dapr-agent-py mirror of Claude Code's Workflow tool: the agent authors a
script in the platform dialect (the tool description IS the spec) and this
tool runs it on the workflow-orchestrator's dynamic-script engine, durably
waiting for the result.

Architecture (mirrors the CallAgent workflow-tool):
- The executor returns an UNYIELDED ``ctx.call_child_workflow`` Task for the
  local bridge workflow ``run_workflow_script_bridge`` (main.py). The parent
  agent loop yields it — event-sourced, so the wait survives pod death and
  replay never double-spawns.
- The bridge = one idempotent START activity (POST the BFF's internal
  execute-script/execute route with a caller-supplied executionId — an
  activity retry re-POSTs the same id and the BFF short-circuits ``reused``)
  + a durable poll loop (``create_timer`` + a read-only status activity).
- The heavy orchestration stays on the workflow-orchestrator app; crossing
  apps via the BFF's internal REST (not cross-app call_child_workflow) keeps
  bookkeeping (rows, project attribution via session lineage, budget) in the
  BFF and avoids the task-hub-boundary termination problems.

Recursion guard (depth 1, mirroring the platform's X-Wfb-Script-Depth): a
session that is ITSELF script-spawned (its instance id carries the
``__durable-script__`` marker) is refused — scripts compose via the
script-level ``workflow()`` hook instead.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Optional

from pydantic import BaseModel, Field

from dapr_agents.tool.workflow.tool_context import WorkflowContextInjectedTool

from .prompt import get_workflow_tool_description

# Marker stamped into every script-spawned session's durable instance id by
# script_agent_dispatch (workflow-orchestrator). Its presence here means THIS
# agent is already running inside a workflow.
SCRIPT_SPAWNED_MARKER = "__durable-script__"

# Terminal execution statuses (mirrors the BFF/journal contract).
TERMINAL_STATUSES = frozenset({"success", "error", "failed", "cancelled"})

DEFAULT_TIMEOUT_MINUTES = 30
MAX_TIMEOUT_MINUTES = 120

# Tool results feed straight back into the model's context — cap a runaway
# returnValue instead of blowing the conversation budget.
MAX_OUTPUT_CHARS = 32_000


class WorkflowArgs(BaseModel):
    script: Optional[str] = Field(
        default=None,
        description=(
            "Inline workflow script (the dialect in this tool's description). "
            "Must begin with a pure-literal `export const meta = { name, ... }`."
        ),
    )
    workflowName: Optional[str] = Field(
        default=None,
        description="Name of a SAVED dynamic-script workflow to run instead of inline source.",
    )
    args: Optional[Any] = Field(
        default=None,
        description=(
            "The script's verbatim input (any JSON value) — becomes the `args` "
            "global. Omit for undefined."
        ),
    )
    budgetTotal: Optional[int] = Field(
        default=None,
        description="Token budget for the run (input+output+cache_creation).",
    )
    timeoutMinutes: Optional[int] = Field(
        default=None,
        description=(
            f"How long this call waits for the run (default {DEFAULT_TIMEOUT_MINUTES}, "
            f"max {MAX_TIMEOUT_MINUTES}). The run continues server-side on timeout; "
            "re-attach with {executionId}."
        ),
    )
    executionId: Optional[str] = Field(
        default=None,
        description=(
            "Re-attach to an execution this tool started earlier (e.g. after a "
            "timeout result) instead of starting a new one."
        ),
    )


def _clamped_timeout_minutes(value: Any) -> int:
    try:
        minutes = int(value)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_MINUTES
    return max(1, min(MAX_TIMEOUT_MINUTES, minutes))


def _schedule_workflow_script(
    ctx: Any,
    script: Optional[str] = None,
    workflowName: Optional[str] = None,
    args: Optional[Any] = None,
    budgetTotal: Optional[int] = None,
    timeoutMinutes: Optional[int] = None,
    executionId: Optional[str] = None,
    _source_agent: Optional[str] = None,
) -> Any:
    """Executor for the Workflow tool.

    Called synchronously by the SDK's dispatch loop inside the parent
    agent_workflow generator. MUST return a Dapr Task (unyielded
    ``ctx.call_child_workflow(...)`` result), not a generator.
    """
    parent_instance_id = str(getattr(ctx, "instance_id", "") or "")
    if SCRIPT_SPAWNED_MARKER in parent_instance_id:
        raise RuntimeError(
            "Workflow nesting is one level only: this agent is already running "
            "inside a workflow. Use the script-level workflow() hook to compose "
            "child workflows instead."
        )

    script_text = str(script or "").strip()
    workflow_name = str(workflowName or "").strip()
    attach_execution_id = str(executionId or "").strip()
    provided = [bool(script_text), bool(workflow_name), bool(attach_execution_id)]
    if sum(provided) != 1:
        raise ValueError(
            "Provide exactly ONE of `script` (inline source), `workflowName` "
            "(saved workflow), or `executionId` (re-attach)."
        )

    # Deterministic-enough execution id: generated once on first execution; on
    # replay the yielded bridge Task is event-sourced (never re-invoked), and
    # ACTIVITY retries inside the bridge re-POST this same id, which the BFF
    # short-circuits (reused) — the CallAgent `ca-<uuid>` precedent.
    execution_id = attach_execution_id or f"wfs{uuid.uuid4().hex[:18]}"

    bridge_input: dict[str, Any] = {
        "executionId": execution_id,
        "attachOnly": bool(attach_execution_id),
        "script": script_text or None,
        "workflowName": workflow_name or None,
        "hasArgs": args is not None,
        "args": args,
        "budgetTotal": budgetTotal if isinstance(budgetTotal, int) else None,
        "timeoutMinutes": _clamped_timeout_minutes(
            timeoutMinutes if timeoutMinutes is not None else DEFAULT_TIMEOUT_MINUTES
        ),
        "parentInstanceId": parent_instance_id,
        "sourceAgent": _source_agent,
    }

    return ctx.call_child_workflow(
        workflow="run_workflow_script_bridge",
        input=bridge_input,
        instance_id=f"{execution_id}:wfsbridge",
    )


class WorkflowScriptTool(WorkflowContextInjectedTool):
    """WorkflowContextInjectedTool that runs a dynamic-script workflow.

    Detected by the agent loop's ``isinstance(tool_obj,
    WorkflowContextInjectedTool)`` branch and dispatched as an inline
    ``ctx.call_child_workflow`` — the workflow's returnValue flows back as
    the tool_result in the same turn, fully event-sourced.
    """


def build_workflow_script_tool() -> WorkflowScriptTool:
    return WorkflowScriptTool(
        name="Workflow",
        description=get_workflow_tool_description(),
        func=_schedule_workflow_script,
        args_model=WorkflowArgs,
    )


# ---------------------------------------------------------------------------
# Pure helpers for the bridge workflow/activities (main.py stays thin; these
# are unit-tested without instantiating the agent).
# ---------------------------------------------------------------------------


def build_start_request(message: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """(BFF method path, JSON body) for the start activity's POST."""
    execution_id = str(message.get("executionId") or "")
    body: dict[str, Any] = {"executionId": execution_id}
    budget = message.get("budgetTotal")
    if isinstance(budget, int):
        body["budgetTotal"] = budget
    if message.get("script"):
        body["script"] = str(message["script"])
        if message.get("hasArgs"):
            body["args"] = message.get("args")
        return "api/internal/agent/workflows/execute-script", body
    body["workflowName"] = str(message.get("workflowName") or "")
    if message.get("hasArgs"):
        body["triggerData"] = message.get("args")
    return "api/internal/agent/workflows/execute", body


def classify_poll(payload: dict[str, Any]) -> dict[str, Any]:
    """Normalize the BFF status route's response into the bridge's poll shape."""
    execution = (
        payload.get("execution") if isinstance(payload.get("execution"), dict) else {}
    )
    runtime = (
        payload.get("runtime") if isinstance(payload.get("runtime"), dict) else {}
    )
    status = str(payload.get("status") or execution.get("status") or "").strip().lower()
    output = execution.get("output")
    runtime_outputs = (
        runtime.get("outputs") if isinstance(runtime.get("outputs"), dict) else {}
    )
    if runtime_outputs.get("returnValue") is not None:
        output = runtime_outputs.get("returnValue")
    elif isinstance(output, dict) and isinstance(output.get("outputs"), dict):
        # DB shape nests the pump outputs: output.outputs.returnValue.
        nested = output["outputs"]
        if "returnValue" in nested:
            output = nested.get("returnValue")
    return {
        "status": status,
        "terminal": status in TERMINAL_STATUSES,
        "output": output,
        "error": payload.get("error") or execution.get("error"),
        "phase": runtime.get("phase") or execution.get("phase"),
    }


def digest_output(value: Any, max_chars: int = MAX_OUTPUT_CHARS) -> Any:
    """Cap a runaway returnValue before it enters the model's context."""
    try:
        encoded = json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        encoded = str(value)
    if len(encoded) <= max_chars:
        return value
    return {
        "truncated": True,
        "totalChars": len(encoded),
        "preview": encoded[:max_chars],
        "note": (
            "returnValue exceeded the tool-result cap; fetch details via the "
            "run UI or narrow the script's return value."
        ),
    }
