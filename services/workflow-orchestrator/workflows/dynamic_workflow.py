"""
Dynamic Workflow Interpreter with Child Workflow Support

A single workflow function that interprets and executes any WorkflowDefinition.
Instead of generating separate workflow code for each definition, this interpreter
walks through the definition's execution order and handles each node type dynamically.

This approach offers several advantages:
1. No code generation or registration needed per workflow
2. Workflow definitions can be updated without redeploying
3. All workflow logic is centralized and testable
4. Native parent-child state management and durability
5. Automatic error propagation from child workflows
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import timedelta
from typing import Any

import dapr.ext.workflow as wf

from core.config import config as orchestrator_config
from core.template_resolver import resolve_templates, NodeOutputs
from core.ap_condition_evaluator import evaluate_conditions
from core.cel_loop import eval_cel_boolean, get_loop_iteration_for_evaluation
from core.output_summary import (
    extract_summary_fields_from_outputs as _extract_summary_fields_from_outputs,
)
from core.set_state import resolve_set_state_updates
from activities.execute_action import execute_action
from activities.persist_state import persist_state
from activities.publish_event import publish_phase_changed
from activities.log_external_event import (
    log_approval_request,
    log_approval_response,
    log_approval_timeout,
)
from activities.log_node_execution import log_node_start, log_node_complete
from activities.persist_results_to_db import persist_results_to_db
from activities.fetch_child_workflow import fetch_child_workflow

logger = logging.getLogger(__name__)

# Create workflow runtime
wfr = wf.WorkflowRuntime()

MUTATING_TOOL_NAMES = {
    "write_file",
    "edit_file",
    "delete_file",
    "mkdir",
    "execute_command",
}

STRICT_DURABLE_PLAN_CONTRACT = str(
    os.environ.get("DURABLE_PLAN_CONTRACT_STRICT", "true")
).strip().lower() not in {"0", "false", "no", "off"}

def is_unresolved_template(value: str) -> bool:
    """Check if a string value is an unresolved template like {{PlanNode.workflow_id}}."""
    return isinstance(value, str) and "{{" in value and "}}" in value


def calculate_progress(completed_nodes: int, total_nodes: int) -> int:
    """Calculate progress percentage based on completed nodes."""
    if total_nodes == 0:
        return 100
    # Loops can cause nodes to execute multiple times; cap to avoid > 100.
    return min(99, round((completed_nodes / total_nodes) * 100))


def _trace_id_from_traceparent(traceparent: object) -> str | None:
    """
    Extract trace-id from W3C traceparent header.
    Format: version-traceid-spanid-flags
    """
    if not isinstance(traceparent, str):
        return None
    parts = traceparent.strip().split("-")
    if len(parts) != 4:
        return None
    trace_id = parts[1]
    return trace_id if trace_id else None


def get_timeout_seconds(config: dict[str, Any]) -> int:
    """Get timeout in seconds from various config formats."""
    if config.get("timeoutSeconds"):
        return int(config["timeoutSeconds"])
    if config.get("timeoutMinutes"):
        return int(config["timeoutMinutes"]) * 60
    if config.get("timeoutHours"):
        return int(config["timeoutHours"]) * 3600
    if config.get("durationSeconds"):
        return int(config["durationSeconds"])
    if config.get("durationMinutes"):
        return int(config["durationMinutes"]) * 60
    if config.get("durationHours"):
        return int(config["durationHours"]) * 3600
    # Default: 24 hours for approval gates, 60 seconds for timers
    return 86400 if "eventName" in config else 60


def _edges_by_source(edges: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    by_source: dict[str, list[dict[str, Any]]] = {}
    for e in edges or []:
        src = str(e.get("source") or "").strip()
        if not src:
            continue
        by_source.setdefault(src, []).append(e)
    return by_source


def _collect_reachable_nodes(
    start_node_ids: list[str],
    edges_by_source: dict[str, list[dict[str, Any]]],
) -> set[str]:
    """Return all nodes reachable from any start node (including the start nodes)."""
    reachable: set[str] = set()
    stack: list[str] = [nid for nid in start_node_ids if nid]

    while stack:
        nid = stack.pop()
        if nid in reachable:
            continue
        reachable.add(nid)
        for e in edges_by_source.get(nid, []):
            tgt = str(e.get("target") or "").strip()
            if tgt and tgt not in reachable:
                stack.append(tgt)

    return reachable


def _get_if_else_branch_targets(
    edges_by_source: dict[str, list[dict[str, Any]]],
    node_id: str,
    source_handle: str,
) -> list[str]:
    targets: list[str] = []
    for e in edges_by_source.get(node_id, []):
        if (e.get("sourceHandle") or None) != source_handle:
            continue
        tgt = str(e.get("target") or "").strip()
        if tgt:
            targets.append(tgt)
    return targets


def _compute_if_else_skip_set(
    edges_by_source: dict[str, list[dict[str, Any]]],
    if_else_node_id: str,
    chosen_branch: str,
) -> set[str]:
    """Compute node IDs to skip for an if/else branch, based on reachability."""
    true_starts = _get_if_else_branch_targets(edges_by_source, if_else_node_id, "true")
    false_starts = _get_if_else_branch_targets(edges_by_source, if_else_node_id, "false")

    true_reachable = _collect_reachable_nodes(true_starts, edges_by_source)
    false_reachable = _collect_reachable_nodes(false_starts, edges_by_source)

    if chosen_branch == "true":
        return false_reachable - true_reachable
    return true_reachable - false_reachable


def _try_parse_json(value: Any) -> Any:
    """Best-effort parse JSON strings into Python objects; otherwise return as-is."""
    if not isinstance(value, str):
        return value
    s = value.strip()
    if not s:
        return value
    if not ((s.startswith("{") and s.endswith("}")) or (s.startswith("[") and s.endswith("]"))):
        return value
    try:
        return json.loads(s)
    except Exception:
        return value

def _parse_optional_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized == "true":
            return True
        if normalized == "false":
            return False
    return None


def _is_native_child_workflow_enabled(
    resolved_config: dict[str, Any],
) -> bool:
    # Hard cutoff: all durable agent execution paths use native Dapr child workflows.
    # Legacy external-event bridge mode is no longer supported.
    return True


def _stop_condition_implies_file_changes(stop_condition: str) -> bool:
    normalized = stop_condition.lower()
    terms = (
        "file changes",
        "files are updated",
        "code changes",
        "files updated",
        "changes are complete",
        "edited files",
        "modified files",
        "apply changes",
        "write files",
        "edit files",
    )
    return any(term in normalized for term in terms)


def _build_run_prompt(
    base_prompt: str,
    stop_condition: str | None,
    require_file_changes: bool,
    cwd: str | None = None,
) -> str:
    cwd_context = ""
    if isinstance(cwd, str) and cwd.strip():
        cwd_context = (
            f"Repository root: {cwd.strip()}\n"
            "Always operate relative to this repository root for file and directory paths.\n\n"
        )

    normalized_stop = stop_condition.strip() if isinstance(stop_condition, str) else ""
    if not normalized_stop:
        return f"{cwd_context}{base_prompt}"

    file_change_guard = (
        "\n\nCRITICAL: You must make real file mutations (write/edit/delete/mkdir) before finalizing. "
        "Do not stop at analysis or directory listing."
        if require_file_changes
        else ""
    )
    return (
        f"{cwd_context}{base_prompt}\n\n"
        f"## Stop Condition\n{normalized_stop}\n\n"
        "Execute autonomously until the stop condition is satisfied. "
        "Do not ask for confirmation before proceeding."
        f"{file_change_guard}"
    )


def _unwrap_child_result_payload(result: dict[str, Any]) -> dict[str, Any]:
    nested = result.get("result")
    if isinstance(nested, dict):
        return nested
    return result


def _extract_tool_calls_from_child_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    payload = _unwrap_child_result_payload(result)
    all_calls = payload.get("all_tool_calls")
    if isinstance(all_calls, list):
        return [c for c in all_calls if isinstance(c, dict)]
    calls = payload.get("tool_calls")
    if isinstance(calls, list):
        return [c for c in calls if isinstance(c, dict)]
    camel_calls = payload.get("toolCalls")
    if isinstance(camel_calls, list):
        return [c for c in camel_calls if isinstance(c, dict)]
    return []


def _has_mutating_tool_calls(tool_calls: list[dict[str, Any]]) -> bool:
    for call in tool_calls:
        tool_name = str(call.get("tool_name") or "").strip().lower()
        if not tool_name:
            fn = call.get("function")
            if isinstance(fn, dict):
                tool_name = str(fn.get("name") or "").strip().lower()
        if (
            tool_name in MUTATING_TOOL_NAMES
            or tool_name.endswith("write_file")
            or tool_name.endswith("edit_file")
            or tool_name.endswith("delete_file")
            or tool_name.endswith("mkdir")
            or tool_name.endswith("execute_command")
        ):
            return True
    return False


def _child_result_explicitly_reports_no_changes(result: dict[str, Any]) -> bool:
    payload = _unwrap_child_result_payload(result)

    direct_flags = (
        payload.get("changed"),
        payload.get("hasChanges"),
        payload.get("fileChangesApplied"),
        payload.get("file_changes_applied"),
    )
    for flag in direct_flags:
        parsed = _parse_optional_bool(flag)
        if parsed is False:
            return True
        if parsed is True:
            return False

    summary = payload.get("summary")
    if isinstance(summary, dict):
        for key in ("changed", "hasChanges"):
            parsed = _parse_optional_bool(summary.get(key))
            if parsed is False:
                return True
            if parsed is True:
                return False

    for key in ("files", "changedFiles", "changed_files", "fileChanges"):
        files = payload.get(key)
        if isinstance(files, list):
            return len(files) == 0

    return False


def _to_compact_agent_result(
    *,
    raw_result: dict[str, Any],
    workflow_id: str,
    dapr_instance_id: str,
    child_workflow_name: str,
    child_app_id: str,
) -> dict[str, Any]:
    payload = _unwrap_child_result_payload(raw_result)
    text = (
        payload.get("final_answer")
        or payload.get("content")
        or payload.get("last_message")
        or ""
    )
    tool_calls = _extract_tool_calls_from_child_result(raw_result)
    return {
        "success": bool(raw_result.get("success", True)),
        "agentWorkflowId": workflow_id,
        "daprInstanceId": dapr_instance_id,
        "childWorkflowName": child_workflow_name,
        "childAppId": child_app_id,
        "text": text,
        "toolCalls": tool_calls,
        "loopStopReason": payload.get("stop_reason"),
        "loopStopCondition": payload.get("stop_condition"),
        "requiresApproval": payload.get("requires_approval"),
        "usageTotals": payload.get("usage_totals"),
        "compactionApplied": bool(payload.get("compaction_applied", False)),
        "compactionCount": payload.get("compaction_count", 0),
        "contextOverflowRecovered": bool(
            payload.get("context_overflow_recovered", False)
        ),
        "lastCompactionReason": payload.get("last_compaction_reason"),
    }


def _build_plan_execution_text(plan: dict[str, Any]) -> str:
    tasks = plan.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        return "1. Execute requested changes using available tools."

    lines: list[str] = []
    for idx, task in enumerate(tasks, 1):
        if not isinstance(task, dict):
            continue
        tool = str(task.get("tool") or "tool")
        task_id = str(task.get("id") or f"task-{idx}")
        title = str(task.get("subject") or task.get("title") or "Task")
        instructions = str(task.get("description") or task.get("instructions") or "").strip()
        reasoning = str(task.get("reasoning") or "").strip()
        blocked_by = task.get("blockedBy")
        deps = ""
        if isinstance(blocked_by, list) and blocked_by:
            deps = f" [blockedBy: {', '.join(str(dep) for dep in blocked_by)}]"
        reason_suffix = f" — {reasoning}" if reasoning else ""
        lines.append(
            f"{idx}. [{tool}] ({task_id}) {title}: {instructions}{reason_suffix}{deps}"
        )
    return "\n".join(lines) if lines else "1. Execute requested changes using available tools."


def _build_execute_plan_prompt(
    *,
    plan: dict[str, Any],
    task_prompt: str,
    cwd: str | None,
    require_file_changes: bool,
) -> str:
    goal = str(plan.get("goal") or "").strip()
    plan_text = _build_plan_execution_text(plan)
    cwd_context = f"Working directory: {cwd.strip()}\n\n" if isinstance(cwd, str) and cwd.strip() else ""
    mutation_requirement = (
        "\nCRITICAL: This execution requires real file mutations. Before finalizing, you MUST perform write/edit/delete/mkdir operations and produce concrete file changes."
        if require_file_changes
        else ""
    )
    effective_task = task_prompt.strip() if task_prompt.strip() else goal
    return (
        f"{cwd_context}"
        "You are now in EXECUTION MODE.\n"
        "Do not ask for more planning or approval. Do not ask clarifying questions. Execute immediately.\n\n"
        f"## Task\n{effective_task}\n\n"
        "## Execution Plan\n"
        "Follow this plan step-by-step:\n"
        f"{plan_text}\n\n"
        "IMPORTANT: Execute all applicable steps with tools. "
        "If a planned path is missing or inaccurate, locate the correct file(s) in this repository and continue. "
        f"If a step fails, record the error and proceed with the next step.{mutation_requirement}"
    )


def _cleanup_execution_workspaces_for_workflow(
    ctx: wf.DaprWorkflowContext,
    execution_id: str,
    db_execution_id: str | None,
    otel_ctx: dict | None,
):
    """
    Best-effort cleanup for execution-scoped workspaces.

    Important: keep this as a normal yield path and do not invoke from a
    `finally` block in workflow generators, which can trigger
    "generator ignored GeneratorExit" in the durable runtime.
    """
    try:
        from activities.call_agent_service import cleanup_execution_workspaces

        yield ctx.call_activity(
            cleanup_execution_workspaces,
            input={
                "executionId": execution_id,
                "dbExecutionId": db_execution_id,
                "_otel": otel_ctx or {},
            },
        )
    except Exception as cleanup_err:
        logger.warning(f"[Dynamic Workflow] Workspace cleanup failed: {cleanup_err}")


def _return_with_workspace_cleanup(
    ctx: wf.DaprWorkflowContext,
    execution_id: str,
    db_execution_id: str | None,
    otel_ctx: dict | None,
    result: dict[str, Any],
):
    yield from _cleanup_execution_workspaces_for_workflow(
        ctx=ctx,
        execution_id=execution_id,
        db_execution_id=db_execution_id,
        otel_ctx=otel_ctx,
    )
    return result


@wfr.workflow(name="dynamic_workflow")
def dynamic_workflow(ctx: wf.DaprWorkflowContext, input_data: dict) -> dict:
    """
    Dynamic Workflow - The main interpreter function

    This workflow function interprets a WorkflowDefinition and executes
    each node in the specified execution order.

    Supports:
    - Action nodes: Regular function execution via function-router
    - Agent nodes: durable/* and mastra/* actions via durable-agent activities
    - Approval gates: Wait for external events with timeout
    - Timers: Delay execution for specified duration
    - Condition nodes: Branching logic

    Args:
        ctx: Dapr workflow context
        input_data: DynamicWorkflowInput as dict

    Returns:
        DynamicWorkflowOutput as dict
    """
    definition = input_data.get("definition", {})
    trigger_data = input_data.get("triggerData", {})
    integrations = input_data.get("integrations")
    db_execution_id = input_data.get("dbExecutionId")
    node_connection_map = input_data.get("nodeConnectionMap") or {}
    otel_ctx = input_data.get("_otel") or {}
    trace_id = _trace_id_from_traceparent(otel_ctx.get("traceparent"))

    start_time = time.time()
    execution_id = ctx.instance_id
    workflow_id = definition.get("id", "unknown")

    logger.info(f"[Dynamic Workflow] Starting workflow: {definition.get('name')} ({execution_id})")

    state_vars: dict[str, Any] = {}

    # Initialize node outputs with trigger data + workflow state variables.
    # `state` is a reserved virtual node ID so templates can reference:
    # - {{state.someKey}}
    # - {{State.someKey}}
    node_outputs: NodeOutputs = {
        "trigger": {"label": "Trigger", "actionType": "", "data": trigger_data},
        "state": {
            "label": "State",
            "actionType": "state",
            "data": {"success": True, "data": state_vars},
        },
    }

    # Set initial status
    ctx.set_custom_status(json.dumps({
        "phase": "running",
        "progress": 0,
        "message": "Workflow started",
        "traceId": trace_id,
    }))

    # Create a map of nodes for quick lookup
    nodes = definition.get("nodes", [])
    node_map = {n.get("id"): n for n in nodes}
    execution_order = definition.get("executionOrder", [])
    node_index_map = {nid: idx for idx, nid in enumerate(execution_order)}
    edges = definition.get("edges", []) or []
    edges_by_source = _edges_by_source(edges)
    total_nodes = len(execution_order)
    completed_node_ids: set[str] = set()
    loop_iterations: dict[str, int] = {}
    skipped_node_ids: set[str] = set()
    skipped_reason_by_node_id: dict[str, dict[str, Any]] = {}

    try:
        # Execute nodes in order
        i = 0
        while i < len(execution_order):
            node_id = execution_order[i]
            node = node_map.get(node_id)
            if not node:
                logger.warning(f"[Dynamic Workflow] Node not found: {node_id}")
                i += 1
                continue

            # Skip disabled nodes
            if node.get("enabled") is False:
                logger.info(f"[Dynamic Workflow] Skipping disabled node: {node.get('label')}")
                completed_node_ids.add(node_id)
                i += 1
                continue

            # Skip nodes excluded by control-flow (e.g., if/else branch not taken)
            if node_id in skipped_node_ids:
                reason = skipped_reason_by_node_id.get(node_id) or {}
                logger.info(
                    f"[Dynamic Workflow] Skipping node due to branch: {node.get('label')} ({reason})"
                )
                skipped_type = node.get("type")
                skipped_config = node.get("config") or {}
                skipped_action_type = skipped_config.get("actionType", "")
                if not skipped_action_type:
                    skipped_action_type = skipped_type or ""
                node_outputs[node.get("id")] = {
                    "label": node.get("label"),
                    "actionType": skipped_action_type,
                    "data": {
                        "success": True,
                        "data": {
                            "skipped": True,
                            **reason,
                        },
                    },
                }
                completed_node_ids.add(node_id)
                i += 1
                continue

            # Update status with current node
            ctx.set_custom_status(json.dumps({
                "phase": "running",
                "progress": calculate_progress(len(completed_node_ids), total_nodes),
                "message": f"Executing: {node.get('label')}",
                "currentNodeId": node.get("id"),
                "currentNodeName": node.get("label"),
                "traceId": trace_id,
            }))

            logger.info(f"[Dynamic Workflow] Processing node: {node.get('label')} ({node.get('type')})")

            node_type = node.get("type")
            config = node.get("config") or {}
            node_result: Any = None

            # --- Action / Activity nodes ---
            if node_type in ("action", "activity"):
                action_type = config.get("actionType", "")

                # Long-running child workflows (bypass function-router).
                # Keep durable/materialize-plan on the regular action path because
                # it is a synchronous tool endpoint that does not require prompt/mode.
                if action_type in (
                    "durable/run",
                    "durable/plan",
                    "durable/claude-plan",
                    "durable/execute-plan",
                    "durable/execute-plan-dag",
                    "mastra/execute",
                ):
                    # Agent nodes publish completion via pub/sub (external events)
                    log_id = None
                    node_start_time = time.time()
                    if db_execution_id:
                        resolved_for_log = resolve_templates(config, node_outputs)
                        start_result = yield ctx.call_activity(
                            log_node_start,
                            input={
                                "executionId": db_execution_id,
                                "nodeId": node.get("id"),
                                "nodeName": node.get("label", ""),
                                "nodeType": node_type,
                                "actionType": action_type,
                                "input": resolved_for_log,
                                "_otel": otel_ctx,
                            },
                        )
                        log_id = start_result.get("logId")

                    node_result = yield from process_agent_child_workflow(
                        ctx=ctx,
                        node=node,
                        node_outputs=node_outputs,
                        action_type=action_type,
                        integrations=integrations,
                        db_execution_id=db_execution_id,
                        connection_external_id=node_connection_map.get(node.get("id")),
                        workflow_id=workflow_id,
                        execution_id=execution_id,
                        otel_ctx=otel_ctx,
                    )

                    if db_execution_id and log_id:
                        node_duration_ms = int((time.time() - node_start_time) * 1000)
                        agent_success = isinstance(node_result, dict) and node_result.get("success", True)
                        yield ctx.call_activity(
                            log_node_complete,
                            input={
                                "logId": log_id,
                                "status": "success" if agent_success else "error",
                                "output": node_result if isinstance(node_result, dict) else {"raw": str(node_result)},
                                "error": node_result.get("error") if isinstance(node_result, dict) and not agent_success else None,
                                "durationMs": node_duration_ms,
                                "_otel": otel_ctx,
                            },
                        )

                    if isinstance(node_result, dict) and not node_result.get("success", True):
                        if not config.get("continueOnError"):
                            raise RuntimeError(
                                node_result.get("error") or f"Agent action failed: {node.get('label')}"
                            )
                        logger.warning(
                            f"[Dynamic Workflow] Agent action failed but continuing: {node_result.get('error')}"
                        )

                else:
                    # Regular action via function-router
                    result = yield ctx.call_activity(
                        execute_action,
                        input={
                            "node": node,
                            "nodeOutputs": node_outputs,
                            "executionId": execution_id,
                            "workflowId": workflow_id,
                            "integrations": integrations,
                            "dbExecutionId": db_execution_id,
                            "connectionExternalId": node_connection_map.get(node.get("id")),
                            "_otel": otel_ctx,
                        }
                    )

                    node_result = result

                    if not result.get("success"):
                        # Check if this is a fatal error or if we should continue
                        if not config.get("continueOnError"):
                            raise RuntimeError(
                                result.get("error") or f"Action failed: {node.get('label')}"
                            )
                        logger.warning(
                            f"[Dynamic Workflow] Action failed but continuing: {result.get('error')}"
                        )

            # --- Approval gate nodes ---
            elif node_type == "approval-gate":
                # Log node start for approval gates (they bypass function-router)
                gate_log_id = None
                gate_start_time = time.time()
                if db_execution_id:
                    start_result = yield ctx.call_activity(
                        log_node_start,
                        input={
                            "executionId": db_execution_id,
                            "nodeId": node.get("id"),
                            "nodeName": node.get("label", ""),
                            "nodeType": node_type,
                            "actionType": "approval-gate",
                            "input": config,
                            "_otel": otel_ctx,
                        },
                    )
                    gate_log_id = start_result.get("logId")

                result = yield from process_approval_gate(
                    ctx, node, execution_id, workflow_id, db_execution_id, otel_ctx
                )
                node_result = result

                # Log node completion for approval gates
                if db_execution_id and gate_log_id:
                    gate_duration_ms = int((time.time() - gate_start_time) * 1000)
                    gate_success = result.get("approved", False)
                    yield ctx.call_activity(
                        log_node_complete,
                        input={
                            "logId": gate_log_id,
                            "status": "success" if gate_success else "error",
                            "output": result,
                            "error": result.get("reason") if not gate_success else None,
                            "durationMs": gate_duration_ms,
                            "_otel": otel_ctx,
                        },
                    )

                if not result.get("approved"):
                    ctx.set_custom_status(json.dumps({
                        "phase": "rejected",
                        "progress": calculate_progress(len(completed_node_ids), total_nodes),
                        "message": f"Rejected: {result.get('reason', 'No reason provided')}",
                        "traceId": trace_id,
                    }))

                    duration_ms = int((time.time() - start_time) * 1000)
                    return (yield from _return_with_workspace_cleanup(
                        ctx=ctx,
                        execution_id=execution_id,
                        db_execution_id=db_execution_id,
                        otel_ctx=otel_ctx,
                        result={
                        "success": False,
                        "outputs": node_outputs,
                        "error": f"Workflow rejected at {node.get('label')}: {result.get('reason')}",
                        "durationMs": duration_ms,
                        "phase": "rejected",
                        },
                    ))

            # --- Loop Until nodes ---
            elif node_type == "loop-until":
                loop_log_id = None
                loop_start_time = time.time()

                resolved_for_log = resolve_templates(config, node_outputs)
                if db_execution_id:
                    start_result = yield ctx.call_activity(
                        log_node_start,
                        input={
                            "executionId": db_execution_id,
                            "nodeId": node.get("id"),
                            "nodeName": node.get("label", ""),
                            "nodeType": node_type,
                            "actionType": "loop-until",
                            "input": resolved_for_log,
                            "_otel": otel_ctx,
                        },
                    )
                    loop_log_id = start_result.get("logId")

                loop_start_node_id = str(config.get("loopStartNodeId") or "").strip()
                max_iterations = int(config.get("maxIterations", 10) or 10)
                delay_seconds = int(config.get("delaySeconds", 0) or 0)
                on_max_iterations = str(config.get("onMaxIterations") or "fail").strip().lower()
                condition_mode = str(config.get("conditionMode") or "").strip()
                loop_pass_count = get_loop_iteration_for_evaluation(loop_iterations, node_id)

                operator = str(config.get("operator") or "EXISTS").strip()
                left_raw = config.get("left", "")
                right_raw = config.get("right", "")
                left_val = left_raw
                right_val = right_raw
                cel_expression = ""

                if condition_mode == "celExpression":
                    cel_expression = str(config.get("celExpression") or "").strip()
                    resolved_expression = resolve_templates(cel_expression, node_outputs)
                    if isinstance(resolved_expression, str):
                        cel_expression = resolved_expression.strip()
                    if cel_expression:
                        last_output_entry = (
                            node_outputs.get(loop_start_node_id)
                            if loop_start_node_id
                            else None
                        )
                        last_output = (
                            last_output_entry.get("data")
                            if isinstance(last_output_entry, dict)
                            else None
                        )
                        workflow_context = {
                            "id": workflow_id,
                            "name": definition.get("name"),
                            "input": trigger_data,
                            "input_as_text": (
                                trigger_data
                                if isinstance(trigger_data, str)
                                else json.dumps(trigger_data, default=str)
                            ),
                        }
                        context_payload = {
                            "input": last_output if last_output is not None else trigger_data,
                            "state": state_vars,
                            "workflow": workflow_context,
                            "iteration": loop_pass_count,
                            "last": last_output,
                        }
                        try:
                            condition_met = eval_cel_boolean(cel_expression, context_payload)
                        except Exception as cel_err:
                            logger.warning(
                                "[Dynamic Workflow] CEL loop condition evaluation failed for node %s: %s",
                                node_id,
                                cel_err,
                            )
                            condition_met = False
                    else:
                        condition_met = False
                    operator = "CEL_EXPRESSION"
                    left_val = cel_expression
                    right_val = ""
                else:
                    resolved_condition = resolve_templates(
                        {"left": left_raw, "right": right_raw},
                        node_outputs,
                    )
                    left_val = (
                        resolved_condition.get("left")
                        if isinstance(resolved_condition, dict)
                        else left_raw
                    )
                    right_val = (
                        resolved_condition.get("right")
                        if isinstance(resolved_condition, dict)
                        else right_raw
                    )
                    # If template resolution failed, treat as missing value for condition evaluation.
                    if is_unresolved_template(left_val):
                        left_val = None
                    if is_unresolved_template(right_val):
                        right_val = None

                    condition_met = evaluate_conditions(
                        [[{"operator": operator, "firstValue": left_val, "secondValue": right_val}]]
                    )

                if condition_met:
                    node_result = {
                        "conditionMet": True,
                        "iteration": loop_pass_count,
                        "operator": operator,
                        "loopStartNodeId": loop_start_node_id,
                    }
                else:
                    # Not met: decide to jump or exit/fail.
                    if not loop_start_node_id:
                        node_result = {
                            "conditionMet": False,
                            "iteration": loop_pass_count,
                            "error": "loopStartNodeId is required",
                        }
                        if db_execution_id and loop_log_id:
                            loop_duration_ms = int((time.time() - loop_start_time) * 1000)
                            yield ctx.call_activity(
                                log_node_complete,
                                input={
                                    "logId": loop_log_id,
                                    "status": "error",
                                    "output": node_result,
                                    "error": node_result.get("error"),
                                    "durationMs": loop_duration_ms,
                                    "_otel": otel_ctx,
                                },
                            )
                        duration_ms = int((time.time() - start_time) * 1000)
                        return (yield from _return_with_workspace_cleanup(
                            ctx=ctx,
                            execution_id=execution_id,
                            db_execution_id=db_execution_id,
                            otel_ctx=otel_ctx,
                            result={
                            "success": False,
                            "outputs": node_outputs,
                            "error": f"Loop misconfigured at {node.get('label')}: loopStartNodeId is required",
                            "durationMs": duration_ms,
                            "phase": "failed",
                            },
                        ))

                    start_index = node_index_map.get(loop_start_node_id)
                    if start_index is None:
                        duration_ms = int((time.time() - start_time) * 1000)
                        err = f"loopStartNodeId not found in executionOrder: {loop_start_node_id}"
                        node_result = {
                            "conditionMet": False,
                            "iteration": loop_pass_count,
                            "error": err,
                        }
                        if db_execution_id and loop_log_id:
                            loop_duration_ms = int((time.time() - loop_start_time) * 1000)
                            yield ctx.call_activity(
                                log_node_complete,
                                input={
                                    "logId": loop_log_id,
                                    "status": "error",
                                    "output": node_result,
                                    "error": err,
                                    "durationMs": loop_duration_ms,
                                    "_otel": otel_ctx,
                                },
                            )
                        return (yield from _return_with_workspace_cleanup(
                            ctx=ctx,
                            execution_id=execution_id,
                            db_execution_id=db_execution_id,
                            otel_ctx=otel_ctx,
                            result={
                            "success": False,
                            "outputs": node_outputs,
                            "error": err,
                            "durationMs": duration_ms,
                            "phase": "failed",
                            },
                        ))

                    if start_index >= i:
                        duration_ms = int((time.time() - start_time) * 1000)
                        err = (
                            f"loopStartNodeId must be before the loop node in execution order "
                            f"(start_index={start_index}, loop_index={i})"
                        )
                        node_result = {
                            "conditionMet": False,
                            "iteration": loop_pass_count,
                            "error": err,
                        }
                        if db_execution_id and loop_log_id:
                            loop_duration_ms = int((time.time() - loop_start_time) * 1000)
                            yield ctx.call_activity(
                                log_node_complete,
                                input={
                                    "logId": loop_log_id,
                                    "status": "error",
                                    "output": node_result,
                                    "error": err,
                                    "durationMs": loop_duration_ms,
                                    "_otel": otel_ctx,
                                },
                            )
                        return (yield from _return_with_workspace_cleanup(
                            ctx=ctx,
                            execution_id=execution_id,
                            db_execution_id=db_execution_id,
                            otel_ctx=otel_ctx,
                            result={
                            "success": False,
                            "outputs": node_outputs,
                            "error": err,
                            "durationMs": duration_ms,
                            "phase": "failed",
                            },
                        ))

                    if max_iterations < 1:
                        max_iterations = 1

                    if loop_pass_count > max_iterations:
                        node_result = {
                            "conditionMet": False,
                            "iteration": loop_pass_count,
                            "maxIterations": max_iterations,
                            "exceededMaxIterations": True,
                            "operator": operator,
                            "loopStartNodeId": loop_start_node_id,
                        }

                        if db_execution_id and loop_log_id:
                            loop_duration_ms = int((time.time() - loop_start_time) * 1000)
                            yield ctx.call_activity(
                                log_node_complete,
                                input={
                                    "logId": loop_log_id,
                                    "status": "success" if on_max_iterations == "continue" else "error",
                                    "output": node_result,
                                    "error": None if on_max_iterations == "continue" else "Max iterations exceeded",
                                    "durationMs": loop_duration_ms,
                                    "_otel": otel_ctx,
                                },
                            )

                        if on_max_iterations == "continue":
                            # Exit loop and continue workflow.
                            node_result["exitedLoop"] = True
                        else:
                            duration_ms = int((time.time() - start_time) * 1000)
                            return (yield from _return_with_workspace_cleanup(
                                ctx=ctx,
                                execution_id=execution_id,
                                db_execution_id=db_execution_id,
                                otel_ctx=otel_ctx,
                                result={
                                "success": False,
                                "outputs": node_outputs,
                                "error": f"Loop exceeded maxIterations ({max_iterations}) at {node.get('label')}",
                                "durationMs": duration_ms,
                                "phase": "failed",
                                },
                            ))
                    else:
                        # Jump back.
                        loop_iterations[node_id] = loop_pass_count

                        if delay_seconds > 0:
                            yield ctx.create_timer(timedelta(seconds=delay_seconds))

                        node_result = {
                            "conditionMet": False,
                            "iteration": loop_pass_count,
                            "maxIterations": max_iterations,
                            "operator": operator,
                            "loopStartNodeId": loop_start_node_id,
                            "jumpToNodeId": loop_start_node_id,
                            "jumpToIndex": start_index,
                        }

                        if db_execution_id and loop_log_id:
                            loop_duration_ms = int((time.time() - loop_start_time) * 1000)
                            yield ctx.call_activity(
                                log_node_complete,
                                input={
                                    "logId": loop_log_id,
                                    "status": "success",
                                    "output": node_result,
                                    "error": None,
                                    "durationMs": loop_duration_ms,
                                    "_otel": otel_ctx,
                                },
                            )

                        # Store output for loop node, then jump without advancing i.
                        node_outputs[node.get("id")] = {
                            "label": node.get("label"),
                            "actionType": node_type,
                            "data": node_result,
                        }
                        completed_node_ids.add(node.get("id"))
                        i = start_index
                        continue

                # Log completion for non-jump cases
                if db_execution_id and loop_log_id:
                    loop_duration_ms = int((time.time() - loop_start_time) * 1000)
                    yield ctx.call_activity(
                        log_node_complete,
                        input={
                            "logId": loop_log_id,
                            "status": "success",
                            "output": node_result,
                            "error": None,
                            "durationMs": loop_duration_ms,
                            "_otel": otel_ctx,
                        },
                    )

            # --- Timer nodes ---
            elif node_type == "timer":
                duration_seconds = get_timeout_seconds(config)
                logger.info(f"[Dynamic Workflow] Starting timer: {node.get('label')} ({duration_seconds}s)")

                # Log node start for timers (they bypass function-router)
                timer_log_id = None
                timer_start_time = time.time()
                if db_execution_id:
                    start_result = yield ctx.call_activity(
                        log_node_start,
                        input={
                            "executionId": db_execution_id,
                            "nodeId": node.get("id"),
                            "nodeName": node.get("label", ""),
                            "nodeType": node_type,
                            "actionType": "timer",
                            "input": config,
                            "_otel": otel_ctx,
                        },
                    )
                    timer_log_id = start_result.get("logId")

                yield ctx.create_timer(timedelta(seconds=duration_seconds))

                logger.info(f"[Dynamic Workflow] Timer completed: {node.get('label')}")
                node_result = {"completed": True}

                # Log node completion for timers
                if db_execution_id and timer_log_id:
                    timer_duration_ms = int((time.time() - timer_start_time) * 1000)
                    yield ctx.call_activity(
                        log_node_complete,
                        input={
                            "logId": timer_log_id,
                            "status": "success",
                            "output": node_result,
                            "error": None,
                            "durationMs": timer_duration_ms,
                            "_otel": otel_ctx,
                        },
                    )

            # --- If/Else nodes ---
            elif node_type == "if-else":
                logger.info(f"[Dynamic Workflow] Evaluating if/else: {node.get('label')}")

                operator = str(config.get("operator") or "EXISTS").strip()
                left_raw = config.get("left", "")
                right_raw = config.get("right", "")

                resolved_condition = resolve_templates(
                    {"left": left_raw, "right": right_raw},
                    node_outputs,
                )
                left_val = (
                    resolved_condition.get("left")
                    if isinstance(resolved_condition, dict)
                    else left_raw
                )
                right_val = (
                    resolved_condition.get("right")
                    if isinstance(resolved_condition, dict)
                    else right_raw
                )

                if is_unresolved_template(left_val):
                    left_val = None
                if is_unresolved_template(right_val):
                    right_val = None

                condition_met = evaluate_conditions(
                    [[{"operator": operator, "firstValue": left_val, "secondValue": right_val}]]
                )
                branch = "true" if condition_met else "false"

                to_skip = _compute_if_else_skip_set(edges_by_source, node_id, branch)
                # Never skip the if/else node itself.
                to_skip.discard(node_id)

                for skipped_id in to_skip:
                    skipped_node_ids.add(skipped_id)
                    skipped_reason_by_node_id[skipped_id] = {
                        "skippedBy": node_id,
                        "reason": "Branch not taken",
                        "branchTaken": branch,
                    }

                node_result = {
                    "success": True,
                    "data": {
                        "conditionMet": condition_met,
                        "branch": branch,
                        "operator": operator,
                        "skippedNodeIds": sorted(list(to_skip)),
                    },
                }

            # --- Set State nodes ---
            elif node_type == "set-state":
                logger.info(f"[Dynamic Workflow] Setting state: {node.get('label')}")
                updates, set_state_error = resolve_set_state_updates(config, node_outputs)

                if set_state_error:
                    node_result = {"success": False, "error": {"message": set_state_error}}
                else:
                    for key, value in updates.items():
                        state_vars[key] = value
                    # Keep the virtual state node updated for template resolution.
                    node_outputs["state"] = {
                        "label": "State",
                        "actionType": "state",
                        "data": {"success": True, "data": state_vars},
                    }
                    node_data: dict[str, Any] = {
                        "updated": updates,
                        "count": len(updates),
                    }
                    if len(updates) == 1:
                        first_key = next(iter(updates))
                        node_data["key"] = first_key
                        node_data["value"] = updates[first_key]
                    node_result = {"success": True, "data": node_data}

                if isinstance(node_result, dict) and not node_result.get("success", True):
                    if not config.get("continueOnError"):
                        raise RuntimeError(
                            node_result.get("error", {}).get("message")
                            if isinstance(node_result.get("error"), dict)
                            else "set-state failed"
                        )

            # --- Transform nodes ---
            elif node_type == "transform":
                logger.info(f"[Dynamic Workflow] Transforming data: {node.get('label')}")
                template_json = config.get("templateJson", "")
                resolved = resolve_templates({"templateJson": template_json}, node_outputs)
                resolved_json = resolved.get("templateJson") if isinstance(resolved, dict) else template_json

                parsed = _try_parse_json(resolved_json)
                if isinstance(parsed, str):
                    node_result = {
                        "success": False,
                        "error": {"message": "transform expects valid JSON (object/array)"},
                    }
                else:
                    node_result = {"success": True, "data": parsed}

                if isinstance(node_result, dict) and not node_result.get("success", True):
                    if not config.get("continueOnError"):
                        raise RuntimeError(
                            node_result.get("error", {}).get("message")
                            if isinstance(node_result.get("error"), dict)
                            else "transform failed"
                        )

            # --- Note nodes ---
            elif node_type == "note":
                # Notes are non-executing annotations; keep them as no-ops if they
                # happen to appear in executionOrder (e.g., legacy saved workflows).
                node_result = {"success": True, "data": {"note": config.get("text", "")}}

            # --- Condition nodes (legacy placeholder) ---
            elif node_type == "condition":
                logger.info(f"[Dynamic Workflow] Evaluating condition: {node.get('label')}")
                node_result = {"success": True, "data": {"result": True, "branch": "true"}}

            # --- Trigger nodes ---
            elif node_type == "trigger":
                # Trigger nodes are just entry points, skip them
                node_result = trigger_data

            # --- Publish event nodes ---
            elif node_type == "publish-event":
                event_config = config
                topic = event_config.get("topic", "workflow.events")
                event_type = event_config.get("eventType", "custom")

                yield ctx.call_activity(publish_phase_changed, input={
                    "workflowId": workflow_id,
                    "executionId": execution_id,
                    "phase": "running",
                    "progress": calculate_progress(len(completed_node_ids), total_nodes),
                    "message": f"Published event: {event_type}",
                    "_otel": otel_ctx,
                })

                node_result = {"published": True, "topic": topic, "eventType": event_type}

            # --- Sub-workflow nodes ---
            elif node_type == "sub-workflow":
                child_workflow_id = config.get("workflowId")

                if not child_workflow_id:
                    raise ValueError(
                        f"sub-workflow node {node_id} has no workflowId configured"
                    )

                logger.info(
                    f"[Dynamic Workflow] Executing sub-workflow: {node.get('label')} "
                    f"(child={child_workflow_id})"
                )

                # Log node start
                sub_log_id = None
                sub_start_time = time.time()
                if db_execution_id:
                    start_result = yield ctx.call_activity(
                        log_node_start,
                        input={
                            "executionId": db_execution_id,
                            "nodeId": node.get("id"),
                            "nodeName": node.get("label", ""),
                            "nodeType": node_type,
                            "actionType": "sub-workflow",
                            "input": config,
                            "_otel": otel_ctx,
                        },
                    )
                    sub_log_id = start_result.get("logId")

                # Step 1: Resolve input mapping template
                input_mapping_raw = config.get("inputMapping", "{}")
                resolved_input = resolve_templates(
                    {"inputMapping": input_mapping_raw}, node_outputs
                )
                resolved_mapping = (
                    resolved_input.get("inputMapping")
                    if isinstance(resolved_input, dict)
                    else input_mapping_raw
                )
                try:
                    trigger_data_child = (
                        json.loads(resolved_mapping)
                        if isinstance(resolved_mapping, str)
                        else resolved_mapping
                    )
                except json.JSONDecodeError:
                    trigger_data_child = {"raw": resolved_mapping}

                # Step 2: Fetch child workflow definition via activity
                parent_chain = input_data.get("parentWorkflowIds", [])
                if workflow_id and workflow_id not in parent_chain:
                    parent_chain = parent_chain + [workflow_id]

                child_info = yield ctx.call_activity(
                    fetch_child_workflow,
                    input={
                        "workflowId": child_workflow_id,
                        "parentWorkflowIds": parent_chain,
                    },
                )

                # Step 3: Execute as child workflow
                child_input = {
                    "definition": child_info["definition"],
                    "triggerData": trigger_data_child,
                    "integrations": integrations,
                    "dbExecutionId": None,  # Don't create separate execution record
                    "nodeConnectionMap": child_info.get("nodeConnectionMap", {}),
                    "parentWorkflowIds": child_info.get("parentWorkflowIds", []),
                    "_otel": otel_ctx,
                }

                child_result = yield ctx.call_child_workflow(
                    dynamic_workflow,
                    input=child_input,
                    instance_id=f"{ctx.instance_id}__sub__{node_id}",
                )

                # Step 4: Collect outputs
                child_success = (
                    child_result.get("success", False)
                    if isinstance(child_result, dict)
                    else False
                )
                node_result = {
                    "success": child_success,
                    "data": {
                        "success": child_success,
                        "outputs": child_result.get("outputs", {}) if isinstance(child_result, dict) else {},
                        "state": child_result.get("state", {}) if isinstance(child_result, dict) else {},
                    },
                }

                # Log node completion
                if db_execution_id and sub_log_id:
                    sub_duration_ms = int((time.time() - sub_start_time) * 1000)
                    yield ctx.call_activity(
                        log_node_complete,
                        input={
                            "logId": sub_log_id,
                            "status": "success" if child_success else "error",
                            "output": node_result,
                            "error": child_result.get("error") if isinstance(child_result, dict) and not child_success else None,
                            "durationMs": sub_duration_ms,
                            "_otel": otel_ctx,
                        },
                    )

                if not child_success:
                    child_error = (
                        child_result.get("error", "Child workflow failed")
                        if isinstance(child_result, dict)
                        else "Child workflow failed"
                    )
                    if not config.get("continueOnError"):
                        raise RuntimeError(
                            f"Sub-workflow failed at {node.get('label')}: {child_error}"
                        )
                    logger.warning(
                        f"[Dynamic Workflow] Sub-workflow failed but continuing: {child_error}"
                    )

            else:
                logger.warning(f"[Dynamic Workflow] Unknown node type: {node_type}, skipping")
                node_result = {"skipped": True, "reason": f"Unknown type: {node_type}"}

            # Store node output (include actionType for template resolver matching)
            output_action_type = config.get("actionType", "")
            if not output_action_type:
                output_action_type = node_type or ""

            # Derive display label for template matching.
            # React Flow nodes store label at node.data.label, not top-level.
            # If still empty, derive from actionType slug so templates like
            # {{Plan.plan}} or {{Clone.result.clonePath}} resolve correctly.
            node_label = node.get("label") or ""
            if not node_label and isinstance(node.get("data"), dict):
                node_label = node["data"].get("label", "")
            if not node_label and config.get("actionType"):
                slug = config["actionType"].rsplit("/", 1)[-1]
                node_label = slug.replace("-", " ").replace("_", " ").title()
            if not node_label:
                node_label = node.get("id", "")

            node_outputs[node.get("id")] = {
                "label": node_label,
                "actionType": output_action_type,
                "data": node_result,
            }

            completed_node_ids.add(node.get("id"))
            i += 1

            # Reserved workflow control channel.
            # Allows specific steps (e.g., MCP "Reply to Client") to request an early stop
            # without failing the workflow.
            try:
                if isinstance(node_result, dict):
                    data = node_result.get("data")
                    if isinstance(data, dict):
                        ctl = data.get("__workflow_builder_control")
                        if isinstance(ctl, dict) and ctl.get("stop") is True:
                            logger.info(
                                f"[Dynamic Workflow] Early stop requested by node: {node.get('label')}"
                            )
                            break
            except Exception:
                # Never let control parsing break workflow execution.
                pass

        # Workflow completed successfully
        duration_ms = int((time.time() - start_time) * 1000)

        ctx.set_custom_status(json.dumps({
            "phase": "completed",
            "progress": 100,
            "message": "Workflow completed successfully",
            "currentNodeId": None,
            "currentNodeName": None,
            "traceId": trace_id,
        }))

        # Persist final outputs
        yield ctx.call_activity(persist_state, input={
            "key": f"workflow:{workflow_id}:{execution_id}:outputs",
            "value": node_outputs,
            "_otel": otel_ctx,
        })

        logger.info(f"[Dynamic Workflow] Completed workflow: {definition.get('name')} ({duration_ms}ms)")

        # Convert node_outputs to simple outputs dict
        outputs = {k: v.get("data") for k, v in node_outputs.items()}

        summary_fields = _extract_summary_fields_from_outputs(outputs)
        final_output = {
            "success": True,
            "outputs": outputs,
            "durationMs": duration_ms,
            "phase": "completed",
            **summary_fields,
        }

        # Persist final results to PostgreSQL (belt-and-suspenders)
        if db_execution_id:
            persist_input = {
                "dbExecutionId": db_execution_id,
                "outputs": outputs,
                "success": True,
                "durationMs": duration_ms,
                "_otel": otel_ctx,
            }
            persist_input.update(summary_fields)
            yield ctx.call_activity(persist_results_to_db, input=persist_input)

        return (yield from _return_with_workspace_cleanup(
            ctx=ctx,
            execution_id=execution_id,
            db_execution_id=db_execution_id,
            otel_ctx=otel_ctx,
            result=final_output,
        ))

    except Exception as e:
        duration_ms = int((time.time() - start_time) * 1000)
        error_message = str(e)

        logger.error(f"[Dynamic Workflow] Workflow failed: {e}")

        ctx.set_custom_status(json.dumps({
            "phase": "failed",
            "progress": calculate_progress(len(completed_node_ids), total_nodes),
            "message": f"Error: {error_message}",
            "traceId": trace_id,
        }))

        outputs = {k: v.get("data") for k, v in node_outputs.items()}

        summary_fields = _extract_summary_fields_from_outputs(outputs)
        final_output = {
            "success": False,
            "outputs": outputs,
            "error": error_message,
            "durationMs": duration_ms,
            "phase": "failed",
            **summary_fields,
        }

        # Persist failure results to PostgreSQL (belt-and-suspenders)
        if db_execution_id:
            try:
                persist_input = {
                    "dbExecutionId": db_execution_id,
                    "outputs": outputs,
                    "success": False,
                    "error": error_message,
                    "durationMs": duration_ms,
                    "_otel": otel_ctx,
                }
                persist_input.update(summary_fields)
                yield ctx.call_activity(persist_results_to_db, input=persist_input)
            except Exception as persist_err:
                logger.error(f"[Dynamic Workflow] Failed to persist error results: {persist_err}")

        return (yield from _return_with_workspace_cleanup(
            ctx=ctx,
            execution_id=execution_id,
            db_execution_id=db_execution_id,
            otel_ctx=otel_ctx,
            result=final_output,
        ))


def process_agent_child_workflow(
    ctx: wf.DaprWorkflowContext,
    node: dict,
    node_outputs: NodeOutputs,
    action_type: str,
    integrations: dict | None,
    db_execution_id: str | None,
    connection_external_id: str | None,
    workflow_id: str,
    execution_id: str,
    otel_ctx: dict | None = None,
):
    """
    Invoke durable/* or mastra/execute actions through durable-agent.

    For execute_direct and approved execute_plan paths, this uses a native Dapr
    child workflow call to the durable-agent app. Plan artifact generation
    (plan_mode) still uses durable-agent plan APIs because it returns artifact
    metadata and approval-specific payloads.
    """
    config = node.get("config") or {}
    otel_ctx = otel_ctx or {}
    resolved_config = resolve_templates(config, node_outputs)
    default_mode = "plan_mode"
    mode = str(resolved_config.get("mode", default_mode) or default_mode).strip().lower()
    if mode not in ("plan_mode", "execute_direct"):
        mode = "execute_direct"
    if action_type == "durable/claude-plan":
        mode = "plan_mode"
    if action_type == "durable/execute-plan-dag":
        mode = "execute_direct"

    configured_artifact_ref = resolved_config.get("artifactRef")
    artifact_ref = (
        str(configured_artifact_ref).strip()
        if isinstance(configured_artifact_ref, str)
        else ""
    )
    prompt = str(resolved_config.get("prompt", "") or "").strip()
    if not prompt and action_type == "mastra/execute":
        prompt = "Execute the provided plan"
    if not prompt and action_type == "durable/execute-plan-dag":
        prompt = "Execute the plan as a DAG workflow"
    if not prompt and mode == "plan_mode":
        return {"success": False, "error": "Agent prompt is required (config.prompt)"}
    if not prompt and mode == "execute_direct" and not artifact_ref:
        return {"success": False, "error": "Agent prompt is required (config.prompt)"}

    agent_config = resolved_config.get("agentConfig")
    if not isinstance(agent_config, dict):
        agent_config = {}

    timeout_raw = resolved_config.get("timeoutMinutes", agent_config.get("timeoutMinutes", 30))
    try:
        timeout_minutes = int(timeout_raw or 30)
    except (TypeError, ValueError):
        timeout_minutes = 30
    if timeout_minutes <= 0:
        timeout_minutes = 30

    approval_timeout_raw = resolved_config.get("approvalTimeoutMinutes", 60)
    try:
        approval_timeout_minutes = int(approval_timeout_raw or 60)
    except (TypeError, ValueError):
        approval_timeout_minutes = 60
    if approval_timeout_minutes <= 0:
        approval_timeout_minutes = 60

    max_turns_raw = resolved_config.get("maxTurns", agent_config.get("maxTurns"))
    max_turns: int | None = None
    try:
        if max_turns_raw is not None:
            max_turns = int(max_turns_raw)
    except (TypeError, ValueError):
        max_turns = None

    if action_type == "durable/execute-plan-dag":
        run_mode = "execute_plan_dag"
        from activities.call_agent_service import call_durable_execute_plan_dag
        call_activity_fn = call_durable_execute_plan_dag
    elif action_type == "mastra/execute" or (mode == "execute_direct" and artifact_ref):
        run_mode = "execute_plan"
        from activities.call_agent_service import call_durable_execute_plan
        call_activity_fn = call_durable_execute_plan
    elif mode == "plan_mode":
        run_mode = "plan_mode"
        from activities.call_agent_service import call_durable_plan
        call_activity_fn = call_durable_plan
    else:
        run_mode = "execute_direct"
        from activities.call_agent_service import call_durable_agent_run
        call_activity_fn = call_durable_agent_run
    native_child_workflow_enabled = _is_native_child_workflow_enabled(resolved_config)
    use_native_child_workflow = native_child_workflow_enabled and run_mode == "execute_direct"
    native_child_task_override: str | None = None
    tracked_execution_id = str(db_execution_id or execution_id or "").strip()
    if not tracked_execution_id:
        tracked_execution_id = str(execution_id or "").strip()

    activity_input = {
        "prompt": prompt,
        "cwd": resolved_config.get("cwd"),
        "model": resolved_config.get("model"),
        "maxTurns": max_turns,
        "timeoutMinutes": timeout_minutes,
        "stopCondition": resolved_config.get("stopCondition"),
        "loopPolicy": resolved_config.get("loopPolicy"),
        "contextPolicyPreset": resolved_config.get("contextPolicyPreset"),
        "requireFileChanges": resolved_config.get("requireFileChanges"),
        "cleanupWorkspace": resolved_config.get("cleanupWorkspace"),
        "agentConfig": agent_config,
        "instructions": resolved_config.get("instructions"),
        "tools": resolved_config.get("tools"),
        "workspaceRef": resolved_config.get("workspaceRef"),
        "planningBackend": "claude_code_v1" if action_type == "durable/claude-plan" else resolved_config.get("planningBackend"),
        "integrations": integrations,
        "dbExecutionId": db_execution_id,
        "connectionExternalId": connection_external_id,
        "parentExecutionId": ctx.instance_id,
        "executionId": tracked_execution_id,
        "workflowId": workflow_id,
        "nodeId": node.get("id"),
        "nodeName": node.get("label") or node.get("id"),
        "approvalTimeoutMinutes": approval_timeout_minutes,
        "_otel": otel_ctx,
    }

    if run_mode == "execute_plan_dag":
        activity_input["artifactRef"] = artifact_ref
        activity_input["cwd"] = resolved_config.get("cwd", "")
        activity_input["maxTaskRetries"] = resolved_config.get("maxTaskRetries")
        activity_input["taskTimeoutMinutes"] = resolved_config.get("taskTimeoutMinutes")
        activity_input["overallTimeoutMinutes"] = resolved_config.get("overallTimeoutMinutes")
        plan_input = resolved_config.get("planJson") or resolved_config.get("plan")
        if plan_input:
            activity_input["plan"] = plan_input

    if action_type == "mastra/execute" or run_mode == "execute_plan":
        activity_input["planJson"] = resolved_config.get("planJson")
        activity_input["artifactRef"] = artifact_ref
        activity_input["cwd"] = resolved_config.get("cwd", "")

    if run_mode == "execute_plan" and action_type == "mastra/execute":
        parsed_plan = _try_parse_json(activity_input.get("planJson"))
        if isinstance(parsed_plan, dict):
            stop_condition_raw = resolved_config.get("stopCondition")
            stop_condition = (
                str(stop_condition_raw).strip()
                if isinstance(stop_condition_raw, str)
                else ""
            )
            explicit_require_file_changes = _parse_optional_bool(
                resolved_config.get("requireFileChanges")
            )
            require_file_changes = (
                explicit_require_file_changes
                if explicit_require_file_changes is not None
                else bool(stop_condition)
                and _stop_condition_implies_file_changes(stop_condition)
            )
            native_child_task_override = _build_execute_plan_prompt(
                plan=parsed_plan,
                task_prompt=prompt,
                cwd=resolved_config.get("cwd"),
                require_file_changes=require_file_changes,
            )
            use_native_child_workflow = native_child_workflow_enabled

    if use_native_child_workflow:
        start_result: dict[str, Any] = {"success": True}
    else:
        start_result = yield ctx.call_activity(
            call_activity_fn,
            input=activity_input,
        )
        if not isinstance(start_result, dict) or not start_result.get("success", False):
            return start_result if isinstance(start_result, dict) else {"success": False, "error": "Failed to start agent"}

    planned_payload: dict[str, Any] | None = None
    if run_mode == "plan_mode":
        if action_type == "durable/claude-plan":
            schema_version = str(start_result.get("schemaVersion") or "").strip()
            storage_backend = str(start_result.get("storageBackend") or "").strip()
            if STRICT_DURABLE_PLAN_CONTRACT and (
                schema_version != "claude_task_graph_v1"
                or storage_backend != "workflow_plan_artifacts"
            ):
                return {
                    "success": False,
                    "error": (
                        "durable/claude-plan contract mismatch: expected "
                        "schemaVersion=claude_task_graph_v1 and "
                        "storageBackend=workflow_plan_artifacts; got "
                        f"schemaVersion={schema_version or '<missing>'} "
                        f"storageBackend={storage_backend or '<missing>'}. "
                        "Deploy a durable-agent image that supports persisted plan artifacts."
                    ),
                    "result": start_result,
                }

        plan_artifact_ref = start_result.get("artifactRef")
        if not isinstance(plan_artifact_ref, str) or not plan_artifact_ref.strip():
            return {
                "success": False,
                "error": "Plan mode did not return artifactRef",
                "result": start_result,
            }

        planned_payload = {
            "artifactRef": plan_artifact_ref,
            "plan": start_result.get("plan"),
            "tasks": start_result.get("tasks"),
            "planMarkdown": start_result.get("planMarkdown"),
            "planPolicy": start_result.get("planPolicy"),
            "schemaVersion": start_result.get("schemaVersion"),
            "storageBackend": start_result.get("storageBackend"),
            "planning": {
                "daprPlanningInstanceId": start_result.get("daprPlanningInstanceId"),
            },
        }

        node_id = str(node.get("id") or "unknown")
        approval_event_name = (
            f"durable_plan_approval_{node_id}_{ctx.instance_id}".lower()
        )

        if db_execution_id:
            yield ctx.call_activity(log_approval_request, input={
                "executionId": db_execution_id,
                "nodeId": node.get("id"),
                "eventName": approval_event_name,
                "timeoutSeconds": approval_timeout_minutes * 60,
                "_otel": otel_ctx,
            })

        ctx.set_custom_status(json.dumps({
            "phase": "awaiting_approval",
            "progress": 50,
            "message": f"Plan ready for approval: {node.get('label')}",
            "currentNodeId": node.get("id"),
            "currentNodeName": node.get("label") or node.get("id"),
            "approvalEventName": approval_event_name,
            "traceId": _trace_id_from_traceparent(otel_ctx.get("traceparent")),
        }))

        yield ctx.call_activity(publish_phase_changed, input={
            "workflowId": workflow_id,
            "executionId": execution_id,
            "phase": "awaiting_approval",
            "progress": 50,
            "message": f"Plan ready for approval: {node.get('label')}",
            "_otel": otel_ctx,
        })

        approval_event = ctx.wait_for_external_event(approval_event_name)
        timeout_timer = ctx.create_timer(timedelta(minutes=approval_timeout_minutes))
        completed_task = yield wf.when_any([approval_event, timeout_timer])

        if completed_task == timeout_timer:
            if db_execution_id:
                yield ctx.call_activity(log_approval_timeout, input={
                    "executionId": db_execution_id,
                    "nodeId": node.get("id"),
                    "eventName": approval_event_name,
                    "timeoutSeconds": approval_timeout_minutes * 60,
                    "_otel": otel_ctx,
                })
            return {
                "success": False,
                "error": f"Plan approval timed out after {approval_timeout_minutes} minutes",
                **planned_payload,
            }

        approval_result = approval_event.get_result() or {}
        if db_execution_id:
            yield ctx.call_activity(log_approval_response, input={
                "executionId": db_execution_id,
                "nodeId": node.get("id"),
                "eventName": approval_event_name,
                "approved": approval_result.get("approved", False),
                "reason": approval_result.get("reason"),
                "respondedBy": approval_result.get("respondedBy") or approval_result.get("approvedBy"),
                "payload": approval_result,
                "_otel": otel_ctx,
            })
        approved = bool(approval_result.get("approved"))
        if not approved:
            reason = approval_result.get("reason") or "Plan was rejected"
            return {
                "success": False,
                "error": str(reason),
                "approval": approval_result,
                **planned_payload,
            }

        ctx.set_custom_status(json.dumps({
            "phase": "executing",
            "progress": 55,
            "message": f"Plan approved, executing: {node.get('label')}",
            "currentNodeId": node.get("id"),
            "currentNodeName": node.get("label") or node.get("id"),
            "traceId": _trace_id_from_traceparent(otel_ctx.get("traceparent")),
        }))

        yield ctx.call_activity(publish_phase_changed, input={
            "workflowId": workflow_id,
            "executionId": execution_id,
            "phase": "executing",
            "progress": 55,
            "message": f"Plan approved, executing: {node.get('label')}",
            "_otel": otel_ctx,
        })

        approved_plan = start_result.get("plan")
        if not isinstance(approved_plan, dict):
            return {
                "success": False,
                "error": "Approved plan payload missing or invalid",
                **planned_payload,
            }

        # Default plan_mode behavior is plan-only with explicit approval.
        # A separate execute node can consume artifactRef and run execution.
        execute_after_approval = (
            _parse_optional_bool(resolved_config.get("executeAfterApproval")) is True
        )
        if not execute_after_approval:
            return {
                "success": True,
                "approved": True,
                "approval": approval_result,
                **planned_payload,
            }

        stop_condition_raw = resolved_config.get("stopCondition")
        stop_condition = (
            str(stop_condition_raw).strip() if isinstance(stop_condition_raw, str) else ""
        )
        explicit_require_file_changes = _parse_optional_bool(
            resolved_config.get("requireFileChanges")
        )
        require_file_changes = (
            explicit_require_file_changes
            if explicit_require_file_changes is not None
            else bool(stop_condition) and _stop_condition_implies_file_changes(stop_condition)
        )
        native_child_task_override = _build_execute_plan_prompt(
            plan=approved_plan,
            task_prompt=prompt,
            cwd=resolved_config.get("cwd"),
            require_file_changes=require_file_changes,
        )
        use_native_child_workflow = native_child_workflow_enabled
        run_mode = "execute_plan"

        if not use_native_child_workflow:
            from activities.call_agent_service import call_durable_execute_plan

            execute_plan_input = {
                **activity_input,
                "planJson": approved_plan,
                "artifactRef": planned_payload.get("artifactRef") if planned_payload else "",
                "cwd": resolved_config.get("cwd", ""),
                "approval": approval_result,
            }
            start_result = yield ctx.call_activity(
                call_durable_execute_plan,
                input=execute_plan_input,
            )
            if (
                not isinstance(start_result, dict)
                or not start_result.get("success", False)
            ):
                return (
                    start_result
                    if isinstance(start_result, dict)
                    else {"success": False, "error": "Failed to start execute-plan run"}
                )

    if use_native_child_workflow:
        node_id = str(node.get("id") or "unknown")
        child_workflow_name = (
            orchestrator_config.DURABLE_AGENT_CHILD_WORKFLOW_EXEC_PLAN_NAME
            if run_mode == "execute_plan"
            else orchestrator_config.DURABLE_AGENT_CHILD_WORKFLOW_RUN_NAME
        ) or "durableRunWorkflow"
        mode_suffix = "execute-plan" if run_mode == "execute_plan" else "run"
        child_instance_id = f"{ctx.instance_id}__durable__{node_id}__{mode_suffix}"
        stop_condition_raw = resolved_config.get("stopCondition")
        stop_condition = (
            str(stop_condition_raw).strip() if isinstance(stop_condition_raw, str) else ""
        )
        explicit_require_file_changes = _parse_optional_bool(
            resolved_config.get("requireFileChanges")
        )
        require_file_changes = (
            explicit_require_file_changes
            if explicit_require_file_changes is not None
            else bool(stop_condition) and _stop_condition_implies_file_changes(stop_condition)
        )
        run_prompt = (
            native_child_task_override
            if isinstance(native_child_task_override, str)
            and native_child_task_override.strip()
            else _build_run_prompt(
                prompt,
                stop_condition,
                require_file_changes,
                resolved_config.get("cwd"),
            )
        )
        child_input: dict[str, Any] = {
            "task": run_prompt,
            "workspaceRef": resolved_config.get("workspaceRef"),
            "executionId": tracked_execution_id,
        }
        if max_turns is not None and max_turns > 0:
            child_input["maxIterations"] = max_turns
        if activity_input.get("loopPolicy") is not None:
            child_input["loopPolicy"] = activity_input.get("loopPolicy")

        if db_execution_id:
            try:
                from activities.track_agent_run import track_agent_run_scheduled

                yield ctx.call_activity(
                    track_agent_run_scheduled,
                    input={
                        "id": child_instance_id,
                        "workflowExecutionId": db_execution_id,
                        "workflowId": workflow_id,
                        "nodeId": node_id,
                        "mode": "execute_plan" if run_mode == "execute_plan" else "run",
                        "agentWorkflowId": child_instance_id,
                        "daprInstanceId": child_instance_id,
                        "parentExecutionId": ctx.instance_id,
                        "workspaceRef": resolved_config.get("workspaceRef"),
                        "artifactRef": (
                            planned_payload.get("artifactRef")
                            if isinstance(planned_payload, dict)
                            else None
                        ),
                        "_otel": otel_ctx,
                    },
                )
            except Exception as track_err:
                logger.warning(
                    f"[Agent Workflow] Failed to persist native child scheduled row for {child_instance_id}: {track_err}"
                )

        logger.info(
            f"[Agent Workflow] Starting native durable child: workflow={child_workflow_name} app_id={orchestrator_config.DURABLE_AGENT_APP_ID} instance={child_instance_id}"
        )
        child_task = ctx.call_child_workflow(
            child_workflow_name,
            input=child_input,
            instance_id=child_instance_id,
            app_id=orchestrator_config.DURABLE_AGENT_APP_ID,
        )
        timeout_timer = ctx.create_timer(timedelta(minutes=timeout_minutes))
        completed_task = yield wf.when_any([child_task, timeout_timer])

        if completed_task == timeout_timer:
            logger.warning(
                f"[Agent Workflow] Native child timed out after {timeout_minutes} minutes: {child_instance_id}"
            )
            terminate_result: dict[str, Any] = {"success": False}
            try:
                from activities.call_agent_service import terminate_durable_agent_run

                terminate_result = yield ctx.call_activity(
                    terminate_durable_agent_run,
                    input={
                        "agentWorkflowId": child_instance_id,
                        "daprInstanceId": child_instance_id,
                        "parentExecutionId": ctx.instance_id,
                        "workspaceRef": resolved_config.get("workspaceRef"),
                        "cleanupWorkspace": True,
                        "reason": (
                            "terminated because parent workflow timed out waiting for "
                            f"native durable child ({timeout_minutes} minutes)"
                        ),
                        "_otel": otel_ctx,
                    },
                )
            except Exception as terminate_err:
                logger.warning(
                    f"[Agent Workflow] Failed to terminate timed out native child {child_instance_id}: {terminate_err}"
                )
                terminate_result = {"success": False, "error": str(terminate_err)}
            timeout_payload = {
                "success": False,
                "agentWorkflowId": child_instance_id,
                "daprInstanceId": child_instance_id,
                "childWorkflowName": child_workflow_name,
                "childAppId": orchestrator_config.DURABLE_AGENT_APP_ID,
                "error": f"Agent timed out after {timeout_minutes} minutes",
                "termination": terminate_result,
                **(planned_payload or {}),
            }
            if db_execution_id:
                try:
                    from activities.track_agent_run import track_agent_run_completed

                    yield ctx.call_activity(
                        track_agent_run_completed,
                        input={
                            "id": child_instance_id,
                            "success": False,
                            "result": timeout_payload,
                            "error": timeout_payload.get("error"),
                            "_otel": otel_ctx,
                        },
                    )
                except Exception as track_err:
                    logger.warning(
                        f"[Agent Workflow] Failed to persist native child completion row for {child_instance_id}: {track_err}"
                    )
            return {
                **timeout_payload,
            }

        raw_result = child_task.get_result()
        if not isinstance(raw_result, dict):
            raw_result = {"content": str(raw_result)}
        result_payload = _to_compact_agent_result(
            raw_result=raw_result,
            workflow_id=child_instance_id,
            dapr_instance_id=child_instance_id,
            child_workflow_name=child_workflow_name,
            child_app_id=orchestrator_config.DURABLE_AGENT_APP_ID,
        )
        if require_file_changes and not _has_mutating_tool_calls(
            result_payload.get("toolCalls", [])
        ):
            # Some child runtimes do not return complete tool-call telemetry.
            # Only hard-fail when the child result explicitly reports no changes.
            if _child_result_explicitly_reports_no_changes(raw_result):
                result_payload["success"] = False
                result_payload["error"] = (
                    "Stop condition requires file changes, but child result explicitly reports no file changes."
                )
            else:
                result_payload["fileChangeVerification"] = "unknown"
                result_payload["fileChangeVerificationWarning"] = (
                    "Could not verify file changes from child tool-call telemetry; proceeding."
                )
        native_result_payload = {**(planned_payload or {}), **result_payload}
        if db_execution_id:
            try:
                from activities.track_agent_run import track_agent_run_completed

                native_success = bool(native_result_payload.get("success", True))
                native_error = native_result_payload.get("error")
                yield ctx.call_activity(
                    track_agent_run_completed,
                    input={
                        "id": child_instance_id,
                        "success": native_success,
                        "result": native_result_payload,
                        "error": str(native_error) if native_error else None,
                        "_otel": otel_ctx,
                    },
                )
            except Exception as track_err:
                logger.warning(
                    f"[Agent Workflow] Failed to persist native child completion row for {child_instance_id}: {track_err}"
                )
        return native_result_payload

    agent_workflow_id = (
        start_result.get("workflow_id")
        or start_result.get("workflowId")
        or start_result.get("agentWorkflowId")
    )
    dapr_instance_id = (
        start_result.get("dapr_instance_id")
        or start_result.get("daprInstanceId")
    )
    if not agent_workflow_id:
        return {
            "success": False,
            "error": "Agent service did not return workflow_id",
            **(planned_payload or {}),
        }

    logger.info(
        f"[Agent Workflow] Started bridged agent run: {agent_workflow_id}. Waiting for completion event..."
    )

    completion_event = ctx.wait_for_external_event(f"agent_completed_{agent_workflow_id}")
    timeout_timer = ctx.create_timer(timedelta(minutes=timeout_minutes))

    completed_task = yield wf.when_any([completion_event, timeout_timer])

    if completed_task == timeout_timer:
        logger.warning(
            f"[Agent Workflow] Timed out after {timeout_minutes} minutes: {agent_workflow_id}"
        )
        terminate_result: dict[str, Any] = {"success": False}
        try:
            from activities.call_agent_service import terminate_durable_agent_run

            terminate_result = yield ctx.call_activity(
                terminate_durable_agent_run,
                input={
                    "agentWorkflowId": agent_workflow_id,
                    "daprInstanceId": dapr_instance_id,
                    "parentExecutionId": ctx.instance_id,
                    "workspaceRef": resolved_config.get("workspaceRef"),
                    "cleanupWorkspace": True,
                    "reason": (
                        "terminated because parent workflow timed out waiting for "
                        f"agent run ({timeout_minutes} minutes)"
                    ),
                    "_otel": otel_ctx,
                },
            )
        except Exception as terminate_err:
            logger.warning(
                f"[Agent Workflow] Failed to terminate timed out child run {agent_workflow_id}: {terminate_err}"
            )
            terminate_result = {"success": False, "error": str(terminate_err)}
        return {
            "success": False,
            "agentWorkflowId": agent_workflow_id,
            "daprInstanceId": dapr_instance_id,
            "error": f"Agent timed out after {timeout_minutes} minutes",
            "termination": terminate_result,
            **(planned_payload or {}),
        }

    event_data = completion_event.get_result() or {}
    logger.info(
        f"[Agent Workflow] Received completion event for {agent_workflow_id}: success={event_data.get('success')}"
    )

    if not event_data.get("success", True):
        return {
            "success": False,
            "agentWorkflowId": agent_workflow_id,
            "error": event_data.get("error") or "Agent failed",
            "result": event_data.get("result"),
            **(planned_payload or {}),
        }

    result_payload = event_data.get("result") or {
        "success": True,
        "agentWorkflowId": agent_workflow_id,
        "data": event_data,
    }

    if planned_payload:
        if isinstance(result_payload, dict):
            merged = {**planned_payload, **result_payload}
            return merged
        return {
            **planned_payload,
            "result": result_payload,
        }

    return result_payload


def process_approval_gate(
    ctx: wf.DaprWorkflowContext,
    node: dict,
    execution_id: str,
    workflow_id: str,
    db_execution_id: str | None,
    otel_ctx: dict | None = None,
):
    """
    Process an approval gate node.

    Waits for an external event (approval) or times out.

    Args:
        ctx: Dapr workflow context
        node: The approval gate node
        execution_id: Current execution ID
        workflow_id: Workflow ID
        db_execution_id: Database execution ID for logging

    Yields:
        Event wait or timer

    Returns:
        Approval result dict
    """
    config = node.get("config") or {}
    otel_ctx = otel_ctx or {}
    event_name = str(config.get("eventName") or f"approval_{node.get('id')}").strip().lower()
    timeout_seconds = get_timeout_seconds(config)

    logger.info(
        f"[Dynamic Workflow] Waiting for approval event: {event_name} (timeout: {timeout_seconds}s)"
    )

    # Log approval request to database for audit trail
    if db_execution_id:
        yield ctx.call_activity(log_approval_request, input={
            "executionId": db_execution_id,
            "nodeId": node.get("id"),
            "eventName": event_name,
            "timeoutSeconds": timeout_seconds,
            "_otel": otel_ctx,
        })

    # Update custom status so the status API reflects awaiting_approval
    # Include the actual eventName so the approve API can raise the correct event
    ctx.set_custom_status(json.dumps({
        "phase": "awaiting_approval",
        "progress": 50,
        "message": f"Waiting for approval: {node.get('label')}",
        "currentNodeId": node.get("id"),
        "currentNodeName": node.get("label") or node.get("id"),
        "approvalEventName": event_name,
        "traceId": _trace_id_from_traceparent(otel_ctx.get("traceparent")),
    }))

    # Publish that we're waiting for approval
    yield ctx.call_activity(publish_phase_changed, input={
        "workflowId": workflow_id,
        "executionId": execution_id,
        "phase": "awaiting_approval",
        "progress": 50,
        "message": f"Waiting for approval: {node.get('label')}",
        "_otel": otel_ctx,
    })

    # Wait for approval event or timeout
    approval_event = ctx.wait_for_external_event(event_name)
    timeout_timer = ctx.create_timer(timedelta(seconds=timeout_seconds))

    completed_task = yield wf.when_any([approval_event, timeout_timer])

    if completed_task == timeout_timer:
        logger.info(f"[Dynamic Workflow] Approval timed out: {event_name}")

        # Log timeout event to database for audit trail
        if db_execution_id:
            yield ctx.call_activity(log_approval_timeout, input={
                "executionId": db_execution_id,
                "nodeId": node.get("id"),
                "eventName": event_name,
                "timeoutSeconds": timeout_seconds,
                "_otel": otel_ctx,
            })

        return {
            "approved": False,
            "reason": f"Timed out after {timeout_seconds} seconds",
        }

    # Get the approval result
    approval_result = approval_event.get_result()

    logger.info(f"[Dynamic Workflow] Approval received: {event_name} - {approval_result}")

    # Log approval response to database for audit trail
    if db_execution_id:
        yield ctx.call_activity(log_approval_response, input={
            "executionId": db_execution_id,
            "nodeId": node.get("id"),
            "eventName": event_name,
            "approved": approval_result.get("approved", False) if approval_result else False,
            "reason": approval_result.get("reason") if approval_result else None,
            "respondedBy": approval_result.get("respondedBy") if approval_result else None,
            "payload": approval_result,
            "_otel": otel_ctx,
        })

    return {
        "approved": approval_result.get("approved", False) if approval_result else False,
        "reason": approval_result.get("reason") if approval_result else None,
        "respondedBy": approval_result.get("respondedBy") if approval_result else None,
    }
