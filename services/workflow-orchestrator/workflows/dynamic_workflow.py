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
import time
from datetime import timedelta
from typing import Any

import dapr.ext.workflow as wf

from core.template_resolver import resolve_templates, NodeOutputs
from core.ap_condition_evaluator import evaluate_conditions
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

logger = logging.getLogger(__name__)

# Create workflow runtime
wfr = wf.WorkflowRuntime()

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


@wfr.workflow(name="dynamic_workflow")
def dynamic_workflow(ctx: wf.DaprWorkflowContext, input_data: dict) -> dict:
    """
    Dynamic Workflow - The main interpreter function

    This workflow function interprets a WorkflowDefinition and executes
    each node in the specified execution order.

    Supports:
    - Action nodes: Regular function execution via function-router
    - Agent nodes: agent/* and mastra/* actions via mastra-agent-tanstack
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

                # Long-running child workflows (bypass function-router)
                if action_type.startswith("durable/") or action_type == "mastra/execute":
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
                    return {
                        "success": False,
                        "outputs": node_outputs,
                        "error": f"Workflow rejected at {node.get('label')}: {result.get('reason')}",
                        "durationMs": duration_ms,
                        "phase": "rejected",
                    }

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
                # If template resolution failed, treat as missing value for condition evaluation.
                if is_unresolved_template(left_val):
                    left_val = None
                if is_unresolved_template(right_val):
                    right_val = None

                condition_met = evaluate_conditions(
                    [[{"operator": operator, "firstValue": left_val, "secondValue": right_val}]]
                )

                current_iter = int(loop_iterations.get(node_id, 0) or 0)

                if condition_met:
                    node_result = {
                        "conditionMet": True,
                        "iteration": current_iter,
                        "operator": operator,
                        "loopStartNodeId": loop_start_node_id,
                    }
                else:
                    # Not met: decide to jump or exit/fail.
                    if not loop_start_node_id:
                        node_result = {
                            "conditionMet": False,
                            "iteration": current_iter,
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
                        return {
                            "success": False,
                            "outputs": node_outputs,
                            "error": f"Loop misconfigured at {node.get('label')}: loopStartNodeId is required",
                            "durationMs": duration_ms,
                            "phase": "failed",
                        }

                    start_index = node_index_map.get(loop_start_node_id)
                    if start_index is None:
                        duration_ms = int((time.time() - start_time) * 1000)
                        err = f"loopStartNodeId not found in executionOrder: {loop_start_node_id}"
                        node_result = {
                            "conditionMet": False,
                            "iteration": current_iter,
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
                        return {
                            "success": False,
                            "outputs": node_outputs,
                            "error": err,
                            "durationMs": duration_ms,
                            "phase": "failed",
                        }

                    if start_index >= i:
                        duration_ms = int((time.time() - start_time) * 1000)
                        err = (
                            f"loopStartNodeId must be before the loop node in execution order "
                            f"(start_index={start_index}, loop_index={i})"
                        )
                        node_result = {
                            "conditionMet": False,
                            "iteration": current_iter,
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
                        return {
                            "success": False,
                            "outputs": node_outputs,
                            "error": err,
                            "durationMs": duration_ms,
                            "phase": "failed",
                        }

                    if max_iterations < 1:
                        max_iterations = 1

                    if current_iter + 1 > max_iterations:
                        node_result = {
                            "conditionMet": False,
                            "iteration": current_iter,
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
                            return {
                                "success": False,
                                "outputs": node_outputs,
                                "error": f"Loop exceeded maxIterations ({max_iterations}) at {node.get('label')}",
                                "durationMs": duration_ms,
                                "phase": "failed",
                            }
                    else:
                        # Jump back.
                        next_iter = current_iter + 1
                        loop_iterations[node_id] = next_iter

                        if delay_seconds > 0:
                            yield ctx.create_timer(timedelta(seconds=delay_seconds))

                        node_result = {
                            "conditionMet": False,
                            "iteration": next_iter,
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
                key_raw = config.get("key", "")
                value_raw = config.get("value", "")

                resolved = resolve_templates({"key": key_raw, "value": value_raw}, node_outputs)
                key = str((resolved.get("key") if isinstance(resolved, dict) else key_raw) or "").strip()
                resolved_value = resolved.get("value") if isinstance(resolved, dict) else value_raw
                resolved_value = _try_parse_json(resolved_value)

                if not key:
                    node_result = {"success": False, "error": {"message": "key is required"}}
                else:
                    state_vars[key] = resolved_value
                    # Keep the virtual state node updated for template resolution.
                    node_outputs["state"] = {
                        "label": "State",
                        "actionType": "state",
                        "data": {"success": True, "data": state_vars},
                    }
                    node_result = {"success": True, "data": {"key": key, "value": resolved_value}}

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

        # Persist final results to PostgreSQL (belt-and-suspenders)
        if db_execution_id:
            yield ctx.call_activity(persist_results_to_db, input={
                "dbExecutionId": db_execution_id,
                "outputs": outputs,
                "success": True,
                "durationMs": duration_ms,
                "_otel": otel_ctx,
            })

        return {
            "success": True,
            "outputs": outputs,
            "durationMs": duration_ms,
            "phase": "completed",
        }

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

        # Persist failure results to PostgreSQL (belt-and-suspenders)
        if db_execution_id:
            try:
                yield ctx.call_activity(persist_results_to_db, input={
                    "dbExecutionId": db_execution_id,
                    "outputs": outputs,
                    "success": False,
                    "error": error_message,
                    "durationMs": duration_ms,
                    "_otel": otel_ctx,
                })
            except Exception as persist_err:
                logger.error(f"[Dynamic Workflow] Failed to persist error results: {persist_err}")

        return {
            "success": False,
            "outputs": outputs,
            "error": error_message,
            "durationMs": duration_ms,
            "phase": "failed",
        }


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
    Invoke a durable/* or mastra/execute action via durable-agent and wait for completion.

    The durable-agent service runs the agent workflow and publishes an
    `agent_completed` event containing `parent_execution_id`. The workflow-orchestrator
    subscription handler forwards that to this parent workflow as an external event:
      agent_completed_{agent_workflow_id}
    """
    config = node.get("config") or {}
    otel_ctx = otel_ctx or {}
    resolved_config = resolve_templates(config, node_outputs)

    prompt = str(resolved_config.get("prompt", "") or "").strip()
    if not prompt and action_type == "mastra/execute":
        prompt = "Execute the provided plan"
    if not prompt:
        return {"success": False, "error": "Agent prompt is required (config.prompt)"}

    timeout_minutes = int(resolved_config.get("timeoutMinutes", 30) or 30)

    if action_type == "mastra/execute":
        from activities.call_agent_service import call_durable_execute_plan
        call_activity_fn = call_durable_execute_plan
    else:
        # All durable/* action types route to durable-agent
        from activities.call_agent_service import call_durable_agent_run
        call_activity_fn = call_durable_agent_run

    activity_input = {
        "prompt": prompt,
        "model": resolved_config.get("model"),
        "maxTurns": resolved_config.get("maxTurns"),
        "stopCondition": resolved_config.get("stopCondition"),
        "agentConfig": resolved_config.get("agentConfig"),
        "instructions": resolved_config.get("instructions"),
        "tools": resolved_config.get("tools"),
        "integrations": integrations,
        "dbExecutionId": db_execution_id,
        "connectionExternalId": connection_external_id,
        "parentExecutionId": ctx.instance_id,
        "executionId": execution_id,
        "workflowId": workflow_id,
        "nodeId": node.get("id"),
        "nodeName": node.get("label") or node.get("id"),
        "_otel": otel_ctx,
    }

    if action_type == "mastra/execute":
        activity_input["planJson"] = resolved_config.get("planJson")
        activity_input["cwd"] = resolved_config.get("cwd", "")
        activity_input["timeoutMinutes"] = resolved_config.get("timeoutMinutes", 30)

    start_result = yield ctx.call_activity(
        call_activity_fn,
        input=activity_input,
    )

    if not isinstance(start_result, dict) or not start_result.get("success", False):
        return start_result if isinstance(start_result, dict) else {"success": False, "error": "Failed to start agent"}

    agent_workflow_id = (
        start_result.get("workflow_id")
        or start_result.get("workflowId")
        or start_result.get("agentWorkflowId")
    )
    if not agent_workflow_id:
        return {
            "success": False,
            "error": "Agent service did not return workflow_id",
        }

    logger.info(
        f"[Agent Workflow] Started agent run: {agent_workflow_id}. Waiting for completion..."
    )

    completion_event = ctx.wait_for_external_event(f"agent_completed_{agent_workflow_id}")
    timeout_timer = ctx.create_timer(timedelta(minutes=timeout_minutes))

    completed_task = yield wf.when_any([completion_event, timeout_timer])

    if completed_task == timeout_timer:
        logger.warning(
            f"[Agent Workflow] Timed out after {timeout_minutes} minutes: {agent_workflow_id}"
        )
        return {
            "success": False,
            "agentWorkflowId": agent_workflow_id,
            "error": f"Agent timed out after {timeout_minutes} minutes",
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
        }

    # The agent workflow publishes its own step result under event_data.result.
    return event_data.get("result") or {
        "success": True,
        "agentWorkflowId": agent_workflow_id,
        "data": event_data,
    }


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
    event_name = config.get("eventName") or f"approval_{node.get('id')}"
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
