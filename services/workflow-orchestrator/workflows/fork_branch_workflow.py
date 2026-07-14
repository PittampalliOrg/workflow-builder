"""One SW 1.0 fork branch, executed as a child workflow.

Concurrency plan P2: ``_handle_fork_task`` used to run branches sequentially
inside the parent's history ("parallel TBD") because a single Dapr workflow
function cannot interleave two ``yield from`` task generators. Fan-out/fan-in
over CHILD workflows is the engine-native way to run them concurrently: the
parent schedules one ``fork_branch_workflow`` instance per branch (bounded per
wave) and joins with ``when_all`` — the same pattern the dynamic-script pump
and ``team_join_workflow`` already use.

The child re-hydrates a TaskContext from the parent's serialized snapshot
(workflow document, trigger data, state vars, task outputs, completed tasks)
and runs exactly one branch task via ``_dispatch_task`` — so nested composites,
``durable/run`` agents, and expression contexts behave as they did inline. It
returns the branch result plus the context deltas the parent merges back.

Caveats (accepted for the prototype):
  * Branches see a SNAPSHOT of parent state taken at fork time; concurrent
    branches cannot observe each other's writes (they could not meaningfully
    do so under the sequential order either, which was spec-order dependent).
    Cross-branch writes to the same state var / task output merge last-wins in
    deterministic wave order.
  * The snapshot (including accumulated task outputs) rides the child-workflow
    input through the actor state store — very large upstream outputs count
    against the 16 MiB gRPC ceiling per branch.
  * A branch failure fails its child workflow; the parent's ``when_all``
    re-raises it, matching the sequential path's exception propagation (other
    branches in the wave run to completion first).
"""

from __future__ import annotations

import logging
from typing import Any

import dapr.ext.workflow as wf

logger = logging.getLogger(__name__)

FORK_BRANCH_WORKFLOW_NAME = "fork_branch_workflow"


def fork_branch_workflow(ctx: wf.DaprWorkflowContext, input_data: dict) -> dict:
    # Local import: this module is imported by app.py for registration while
    # sw_workflow dispatches the child by name string, so the import direction
    # stays acyclic (fork_branch_workflow -> sw_workflow only).
    from core.sw_types import Workflow
    from workflows.sw_workflow import (
        TaskContext,
        _dispatch_task,
        _trace_id_from_otel,
    )

    workflow = Workflow.model_validate(input_data.get("workflow", {}))
    trigger_data = input_data.get("triggerData")
    tc = TaskContext(
        workflow=workflow,
        workflow_id=input_data.get("workflowId"),
        trigger_data=trigger_data if isinstance(trigger_data, dict) else {},
        execution_id=ctx.instance_id,
        db_execution_id=input_data.get("dbExecutionId"),
        integrations=input_data.get("integrations"),
    )
    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    tc.otel_ctx = otel
    tc.workflow_otel_ctx = otel
    tc.trace_id = _trace_id_from_otel(otel)

    workspace_execution_id = input_data.get("workspaceExecutionId")
    if isinstance(workspace_execution_id, str) and workspace_execution_id.strip():
        # Branch sessions must mount the PARENT run's shared /sandbox/work —
        # the child's own instance id would point at an empty workspace.
        tc.workspace_execution_id = workspace_execution_id.strip()
    seed_from = input_data.get("seedWorkspaceFrom")
    if isinstance(seed_from, str) and seed_from.strip():
        tc.seed_workspace_from = seed_from.strip()
    tc.resumable = bool(input_data.get("resumable"))

    parent_outputs = input_data.get("taskOutputs")
    if isinstance(parent_outputs, dict) and parent_outputs:
        tc.task_outputs = dict(parent_outputs)
    state_vars = input_data.get("stateVars")
    if isinstance(state_vars, dict):
        tc.state_vars = dict(state_vars)
    completed_tasks = input_data.get("completedTasks")
    if isinstance(completed_tasks, list):
        tc.completed_tasks = {str(item) for item in completed_tasks}

    branch_task_name = str(input_data.get("branchTaskName") or "branch")
    branch_task = (
        input_data.get("branchTask")
        if isinstance(input_data.get("branchTask"), dict)
        else {}
    )

    result = yield from _dispatch_task(ctx, branch_task_name, branch_task, tc)

    snapshot = parent_outputs if isinstance(parent_outputs, dict) else {}
    changed_outputs = {
        key: value
        for key, value in tc.task_outputs.items()
        if key != "trigger" and (key not in snapshot or snapshot[key] != value)
    }
    return {
        "success": True,
        "branchTaskName": branch_task_name,
        "result": result,
        "taskOutputs": changed_outputs,
        "stateVars": tc.state_vars,
        "completedTasks": sorted(tc.completed_tasks),
        "taskExecutionCounts": tc.task_execution_counts,
    }
