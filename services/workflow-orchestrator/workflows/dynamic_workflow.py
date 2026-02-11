"""
Dynamic Workflow Interpreter with Child Workflow Support

A single workflow function that interprets and executes any WorkflowDefinition.
Instead of generating separate workflow code for each definition, this interpreter
walks through the definition's execution order and handles each node type dynamically.

KEY FEATURE: Native multi-app child workflow support for planner/* actions.
When a node's actionType starts with "planner/", the workflow invokes the
planner-dapr-agent's workflow as a true child workflow using Dapr's
call_child_workflow with app_id parameter.

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
from activities.execute_action import execute_action
from activities.persist_state import persist_state
from activities.publish_event import publish_phase_changed
from activities.log_external_event import (
    log_approval_request,
    log_approval_response,
    log_approval_timeout,
)
from activities.log_node_execution import log_node_start, log_node_complete

logger = logging.getLogger(__name__)

# Create workflow runtime
wfr = wf.WorkflowRuntime()

PLANNER_ACTION_ALIASES: dict[str, str] = {
    "planner/run_workflow": "planner/run-workflow",
    "planner/plan_tasks": "planner/plan",
    "planner/execute_tasks": "planner/execute",
    "planner/multi_step": "planner/multi-step",
    "planner/check_status": "planner/status",
    "run planner workflow": "planner/run-workflow",
    "plan tasks only": "planner/plan",
    "execute tasks only": "planner/execute",
    "execute plan tasks only": "planner/execute",
    "clone repository": "planner/clone",
    "clone, plan & execute in sandbox": "planner/multi-step",
    "approve plan": "planner/approve",
    "check plan status": "planner/status",
    "run planning agent": "planner/plan",
    "run execution agent": "planner/execute",
    "dapr:run_planning": "planner/plan",
    "dapr:run_execution": "planner/execute",
}


def normalize_planner_action_type(action_type: str) -> str:
    """Normalize planner action aliases to canonical planner/* slugs."""
    if not action_type:
        return action_type

    normalized_key = (
        action_type.strip().lower().replace("-", "_")
    )
    return PLANNER_ACTION_ALIASES.get(normalized_key, action_type)


def is_unresolved_template(value: str) -> bool:
    """Check if a string value is an unresolved template like {{PlanNode.workflow_id}}."""
    return isinstance(value, str) and "{{" in value and "}}" in value


def find_workflow_id_in_outputs(node_outputs: NodeOutputs) -> str | None:
    """Scan node_outputs for a workflow_id from a previous planner node."""
    for nid, output in node_outputs.items():
        data = output.get("data", {})
        if isinstance(data, dict) and data.get("workflow_id"):
            logger.info(f"[Planner Workflow] Found workflow_id from node {nid}: {data['workflow_id']}")
            return data["workflow_id"]
    return None


def calculate_progress(completed_nodes: int, total_nodes: int) -> int:
    """Calculate progress percentage based on completed nodes."""
    if total_nodes == 0:
        return 100
    return round((completed_nodes / total_nodes) * 100)


def get_timeout_seconds(config: dict[str, Any]) -> int:
    """Get timeout in seconds from various config formats."""
    if config.get("timeoutSeconds"):
        return int(config["timeoutSeconds"])
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


def _normalize_git_branch(branch_value: object) -> str:
    """Normalize optional branch values and default to main for empty input."""
    branch = str(branch_value or "").strip()
    return branch or "main"


@wfr.workflow(name="dynamic_workflow")
def dynamic_workflow(ctx: wf.DaprWorkflowContext, input_data: dict) -> dict:
    """
    Dynamic Workflow - The main interpreter function

    This workflow function interprets a WorkflowDefinition and executes
    each node in the specified execution order.

    Supports:
    - Action nodes: Regular function execution via function-router
    - Planner child workflows: planner/* actions invoke planner-dapr-agent
      as a native Dapr child workflow
    - Approval gates: Wait for external events with timeout
    - Timers: Delay execution for specified duration
    - Condition nodes: Branching logic (placeholder)

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

    start_time = time.time()
    execution_id = ctx.instance_id
    workflow_id = definition.get("id", "unknown")

    logger.info(f"[Dynamic Workflow] Starting workflow: {definition.get('name')} ({execution_id})")

    # Initialize node outputs with trigger data
    node_outputs: NodeOutputs = {
        "trigger": {"label": "Trigger", "actionType": "", "data": trigger_data}
    }

    # Set initial status
    ctx.set_custom_status(json.dumps({
        "phase": "running",
        "progress": 0,
        "message": "Workflow started",
    }))

    # Create a map of nodes for quick lookup
    nodes = definition.get("nodes", [])
    node_map = {n.get("id"): n for n in nodes}
    execution_order = definition.get("executionOrder", [])
    total_nodes = len(execution_order)
    completed_nodes = 0

    try:
        # Execute nodes in order
        for node_id in execution_order:
            node = node_map.get(node_id)
            if not node:
                logger.warning(f"[Dynamic Workflow] Node not found: {node_id}")
                continue

            # Skip disabled nodes
            if node.get("enabled") is False:
                logger.info(f"[Dynamic Workflow] Skipping disabled node: {node.get('label')}")
                completed_nodes += 1
                continue

            # Update status with current node
            ctx.set_custom_status(json.dumps({
                "phase": "running",
                "progress": calculate_progress(completed_nodes, total_nodes),
                "message": f"Executing: {node.get('label')}",
                "currentNodeId": node.get("id"),
                "currentNodeName": node.get("label"),
            }))

            logger.info(f"[Dynamic Workflow] Processing node: {node.get('label')} ({node.get('type')})")

            node_type = node.get("type")
            config = node.get("config") or {}
            node_result: Any = None

            # --- Action / Activity nodes ---
            if node_type in ("action", "activity"):
                raw_action_type = config.get("actionType", "")
                action_type = normalize_planner_action_type(raw_action_type)

                if raw_action_type != action_type:
                    logger.info(
                        f"[Dynamic Workflow] Normalized actionType "
                        f"'{raw_action_type}' -> '{action_type}'"
                    )

                # Check if this is a planner child workflow
                if action_type.startswith("planner/"):
                    # Log node start for planner/* nodes (they bypass function-router)
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
                            },
                        )
                        log_id = start_result.get("logId")

                    node_result = yield from process_planner_child_workflow(
                        ctx,
                        node,
                        node_outputs,
                        action_type,
                        integrations,
                        db_execution_id,
                        node_connection_map.get(node.get("id")),
                    )

                    # Log node completion for planner/* nodes
                    if db_execution_id and log_id:
                        node_duration_ms = int((time.time() - node_start_time) * 1000)
                        planner_success = isinstance(node_result, dict) and node_result.get("success", True)
                        yield ctx.call_activity(
                            log_node_complete,
                            input={
                                "logId": log_id,
                                "status": "success" if planner_success else "error",
                                "output": node_result if isinstance(node_result, dict) else {"raw": str(node_result)},
                                "error": node_result.get("error") if isinstance(node_result, dict) and not planner_success else None,
                                "durationMs": node_duration_ms,
                            },
                        )

                    # Check for errors in planner child workflow results
                    if isinstance(node_result, dict) and not node_result.get("success", True):
                        if not config.get("continueOnError"):
                            raise RuntimeError(
                                node_result.get("error") or f"Planner action failed: {node.get('label')}"
                            )
                        logger.warning(
                            f"[Dynamic Workflow] Planner action failed but continuing: {node_result.get('error')}"
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
                        },
                    )
                    gate_log_id = start_result.get("logId")

                result = yield from process_approval_gate(
                    ctx, node, execution_id, workflow_id, db_execution_id
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
                        },
                    )

                if not result.get("approved"):
                    ctx.set_custom_status(json.dumps({
                        "phase": "rejected",
                        "progress": calculate_progress(completed_nodes, total_nodes),
                        "message": f"Rejected: {result.get('reason', 'No reason provided')}",
                    }))

                    duration_ms = int((time.time() - start_time) * 1000)
                    return {
                        "success": False,
                        "outputs": node_outputs,
                        "error": f"Workflow rejected at {node.get('label')}: {result.get('reason')}",
                        "durationMs": duration_ms,
                        "phase": "rejected",
                    }

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
                        },
                    )

            # --- Condition nodes ---
            elif node_type == "condition":
                # TODO: Implement condition evaluation logic
                logger.info(f"[Dynamic Workflow] Evaluating condition: {node.get('label')}")
                node_result = {"result": True, "branch": "true"}

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
                    "progress": calculate_progress(completed_nodes, total_nodes),
                    "message": f"Published event: {event_type}",
                })

                node_result = {"published": True, "topic": topic, "eventType": event_type}

            else:
                logger.warning(f"[Dynamic Workflow] Unknown node type: {node_type}, skipping")
                node_result = {"skipped": True, "reason": f"Unknown type: {node_type}"}

            # Store node output (include actionType for template resolver matching)
            output_action_type = config.get("actionType", "")
            if node_type in ("action", "activity"):
                output_action_type = normalize_planner_action_type(output_action_type)

            node_outputs[node.get("id")] = {
                "label": node.get("label"),
                "actionType": output_action_type,
                "data": node_result,
            }

            completed_nodes += 1

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
        }))

        # Persist final outputs
        yield ctx.call_activity(persist_state, input={
            "key": f"workflow:{workflow_id}:{execution_id}:outputs",
            "value": node_outputs,
        })

        logger.info(f"[Dynamic Workflow] Completed workflow: {definition.get('name')} ({duration_ms}ms)")

        # Convert node_outputs to simple outputs dict
        outputs = {k: v.get("data") for k, v in node_outputs.items()}

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
            "progress": calculate_progress(completed_nodes, total_nodes),
            "message": f"Error: {error_message}",
        }))

        outputs = {k: v.get("data") for k, v in node_outputs.items()}

        return {
            "success": False,
            "outputs": outputs,
            "error": error_message,
            "durationMs": duration_ms,
            "phase": "failed",
        }


def process_planner_child_workflow(
    ctx: wf.DaprWorkflowContext,
    node: dict,
    node_outputs: NodeOutputs,
    action_type: str,
    integrations: dict | None,
    db_execution_id: str | None,
    connection_external_id: str | None = None,
):
    """
    Invoke planner-dapr-agent workflow via Dapr service invocation with event-based completion.

    The planner-dapr-agent service orchestrates Claude Agent SDK for planning
    and execution with features like:
    - AI-powered planning with task creation
    - Human approval gates
    - Automated execution

    Event-based completion (Option C - Hybrid with Pub/Sub):
    - Parent workflow passes db_execution_id as parent_execution_id
    - Planner-orchestrator publishes completion events to workflow.events topic
    - Parent workflow waits for external events instead of polling

    Supported action types:
    - planner/run-workflow: Full multi-step workflow (plan → approve → execute)
    - planner/plan: Just the planning phase (returns tasks) - waits for planner_planning_completed
    - planner/execute: Continue execution after approval - waits for planner_execution_completed
    - planner/approve: Approve or reject a plan
    - planner/status: Get workflow status

    Args:
        ctx: Dapr workflow context
        node: The action node
        node_outputs: Current node outputs for template resolution
        action_type: The planner action type (e.g., "planner/run-workflow")
        integrations: User's integration credentials
        db_execution_id: Database execution ID (used as parent_execution_id for event routing)
        connection_external_id: Selected app connection external ID for this node

    Yields:
        Activity calls to planner-dapr-agent and event waits

    Returns:
        Result from planner workflow
    """
    config = node.get("config") or {}
    resolved_config = resolve_templates(config, node_outputs)

    # Get timeout settings from config (default: 30 min for planning, 2 hours for execution)
    planning_timeout_minutes = int(resolved_config.get("planningTimeoutMinutes", 30))
    execution_timeout_minutes = int(resolved_config.get("executionTimeoutMinutes", 120))

    logger.info(f"[Planner Workflow] Invoking {action_type} on planner-dapr-agent")

    if action_type == "planner/clone":
        # Standalone clone: clone a repository to workspace
        from activities.call_planner_service import call_planner_clone

        logger.info(f"[Planner Workflow] Starting standalone clone via /clone")

        # Resolve GitHub token: node config > user's GitHub integration > empty
        token = resolved_config.get("repositoryToken", "")
        if not token and integrations:
            github_integration = integrations.get("github", {})
            token = github_integration.get("token", "") or github_integration.get("accessToken", "")
            if token:
                logger.info("[Planner Workflow] Using GitHub token from user integrations")

        result = yield ctx.call_activity(
            call_planner_clone,
            input={
                "owner": resolved_config.get("repositoryOwner", ""),
                "repo": resolved_config.get("repositoryRepo", ""),
                "branch": _normalize_git_branch(
                    resolved_config.get("repositoryBranch", "main")
                ),
                "token": token,
                "connection_external_id": connection_external_id,
                "execution_id": ctx.instance_id,
            },
        )

        return result

    elif action_type == "planner/run-workflow":
        # Full multi-step workflow: plan → approve → execute
        # Uses planner-dapr-agent /api/workflows endpoint
        from activities.call_planner_service import call_planner_workflow

        logger.info(f"[Planner Workflow] Starting full workflow via planner-dapr-agent")

        # Start the workflow, passing ctx.instance_id for event routing back to this workflow
        result = yield ctx.call_activity(
            call_planner_workflow,
            input={
                "workflow_id": ctx.instance_id,
                "feature_request": resolved_config.get("featureRequest", ""),
                "cwd": resolved_config.get("cwd", "/workspace"),
                "repo_url": resolved_config.get("repoUrl", ""),
                "auto_approve": resolved_config.get("autoApprove", False),
                "parent_execution_id": ctx.instance_id,  # For event routing (Dapr workflow ID)
            }
        )

        # If requires_approval, the workflow is waiting and we return the workflow_id
        # for the user to use in a subsequent approval gate + execute step
        if result.get("requires_approval"):
            logger.info(f"[Planner Workflow] Workflow requires approval: {result.get('workflow_id')}")
            return result

        logger.info(f"[Planner Workflow] Full workflow result: success={result.get('success')}")
        return result

    elif action_type == "planner/plan":
        # Planning phase - the activity polls to completion (standard mode runs full workflow)
        from activities.call_planner_service import call_planner_plan

        logger.info(f"[Planner Workflow] Starting planning via planner-dapr-agent")

        # Start the planning workflow - activity polls until planner-dapr-agent finishes
        result = yield ctx.call_activity(
            call_planner_plan,
            input={
                "workflow_id": ctx.instance_id,
                "feature_request": resolved_config.get("featureRequest", ""),
                "cwd": resolved_config.get("cwd", "/workspace"),
                "repo_url": resolved_config.get("repoUrl", ""),
                "parent_execution_id": ctx.instance_id,  # For event routing (Dapr workflow ID)
            }
        )

        # The activity already polled to completion - return the result directly.
        # No need to wait_for_external_event since _poll_workflow_completion already waited.
        planner_workflow_id = result.get("workflow_id", "")
        logger.info(
            f"[Planner Workflow] Plan activity completed: "
            f"workflow_id={planner_workflow_id}, success={result.get('success')}"
        )

        if not result.get("success"):
            return {
                "success": False,
                "workflow_id": planner_workflow_id,
                "error": result.get("error", "Planning failed"),
            }

        return {
            "success": True,
            "workflow_id": planner_workflow_id,
            "tasks": result.get("tasks", []),
            "task_count": result.get("taskCount", 0),
            "output": result.get("output", {}),
            "phase": result.get("phase", "planning_complete"),
        }

    elif action_type == "planner/execute":
        # Execute phase - approve and run, or return results if already completed
        from activities.call_planner_service import call_planner_approve, call_planner_status, call_planner_execute_standalone

        # Get the planner workflow ID from config or previous node output
        planner_workflow_id = resolved_config.get("plannerWorkflowId", "") or resolved_config.get("workflowId", "")

        # Detect unresolved templates and fall back to scanning node outputs
        if not planner_workflow_id or is_unresolved_template(planner_workflow_id):
            logger.warning(f"[Planner Workflow] Unresolved template for workflow_id: {planner_workflow_id}, scanning node outputs")
            planner_workflow_id = find_workflow_id_in_outputs(node_outputs) or ""

        if not planner_workflow_id:
            return {
                "success": False,
                "error": "No planner workflow ID provided. Set a node label and use {{NodeLabel.workflow_id}} template.",
            }

        # Check if the workflow already completed (standard mode runs everything)
        status_result = yield ctx.call_activity(
            call_planner_status,
            input={"planner_workflow_id": planner_workflow_id},
        )

        status = (status_result.get("status", "") or "").upper()
        if status in ("COMPLETED", "SUCCEEDED"):
            logger.info(f"[Planner Workflow] Workflow {planner_workflow_id} already completed, returning results")
            output = status_result.get("output", {})
            tasks = []
            if isinstance(output, dict):
                tasks = output.get("tasks", [])
            return {
                "success": True,
                "workflow_id": planner_workflow_id,
                "result": output,
                "tasks": tasks,
                "task_count": len(tasks),
                "phase": "execution_complete",
                "message": "Workflow already completed (executed in standard mode)",
            }

        # If no Dapr workflow instance exists, use standalone /execute endpoint
        # This happens when plan was done via standalone /plan (not Dapr workflow)
        if not status_result.get("success"):
            error_msg = status_result.get("error", "")
            if "no such instance" in error_msg or "not found" in error_msg.lower() or "404" in error_msg or "500" in error_msg:
                logger.info(f"[Planner Workflow] No Dapr workflow instance, using standalone /execute endpoint")

                # Get tasks from previous plan node output
                plan_tasks = []
                plan_data = {}
                for nid, output in node_outputs.items():
                    data = output.get("data", {})
                    if isinstance(data, dict) and data.get("tasks"):
                        plan_tasks = data["tasks"]
                        plan_data = data.get("output", {})
                        break

                cwd = resolved_config.get("cwd", "/workspace")
                result = yield ctx.call_activity(
                    call_planner_execute_standalone,
                    input={
                        "tasks": plan_tasks,
                        "plan": plan_data,
                        "cwd": cwd,
                        "workflow_id": planner_workflow_id,
                    },
                )
                return result

        logger.info(f"[Planner Workflow] Approving and executing workflow: {planner_workflow_id}")

        # Approve the plan to trigger execution
        approve_result = yield ctx.call_activity(
            call_planner_approve,
            input={
                "planner_workflow_id": planner_workflow_id,
                "approved": True,
                "reason": "Approved by workflow builder",
            }
        )

        if not approve_result.get("success"):
            return {
                "success": False,
                "workflow_id": planner_workflow_id,
                "error": approve_result.get("error", "Failed to approve plan"),
            }

        logger.info(f"[Planner Workflow] Plan approved, waiting for execution completion event")

        # Wait for execution completion event
        execution_event = ctx.wait_for_external_event(f"planner_execution_{planner_workflow_id}")
        timeout_timer = ctx.create_timer(timedelta(minutes=execution_timeout_minutes))

        completed_task = yield wf.when_any([execution_event, timeout_timer])

        if completed_task == timeout_timer:
            logger.warning(f"[Planner Workflow] Execution timed out after {execution_timeout_minutes} minutes")
            return {
                "success": False,
                "workflow_id": planner_workflow_id,
                "error": f"Execution timed out after {execution_timeout_minutes} minutes",
            }

        # Get the execution result from the event
        event_data = execution_event.get_result()
        logger.info(f"[Planner Workflow] Received execution completion event: success={event_data.get('success')}")

        if not event_data.get("success"):
            return {
                "success": False,
                "workflow_id": planner_workflow_id,
                "error": event_data.get("error", "Execution failed"),
            }

        return {
            "success": True,
            "workflow_id": planner_workflow_id,
            "result": event_data.get("result", {}),
            "tasks": event_data.get("tasks", []),
            "task_count": event_data.get("task_count", 0),
            "phase": "execution_complete",
        }

    elif action_type == "planner/approve":
        # Approve or reject a plan - uses /api/workflows/{id}/approve
        from activities.call_planner_service import call_planner_approve, call_planner_status

        planner_workflow_id = resolved_config.get("plannerWorkflowId", "") or resolved_config.get("workflowId", "")
        approved = resolved_config.get("approved", True)
        reason = resolved_config.get("reason", "")

        # Detect unresolved templates and fall back to scanning node outputs
        if not planner_workflow_id or is_unresolved_template(planner_workflow_id):
            logger.warning(f"[Planner Workflow] Unresolved template for workflow_id: {planner_workflow_id}, scanning node outputs")
            planner_workflow_id = find_workflow_id_in_outputs(node_outputs) or ""

        if not planner_workflow_id:
            return {
                "success": False,
                "error": "No planner workflow ID provided. Set a node label and use {{NodeLabel.workflow_id}} template.",
            }

        # Check if the workflow already completed (standard mode runs everything)
        # or if no Dapr workflow instance exists (standalone /plan was used)
        status_result = yield ctx.call_activity(
            call_planner_status,
            input={"planner_workflow_id": planner_workflow_id},
        )

        status = (status_result.get("status", "") or "").upper()
        if status in ("COMPLETED", "SUCCEEDED"):
            logger.info(f"[Planner Workflow] Workflow {planner_workflow_id} already completed, skipping approve")
            return {
                "success": True,
                "approved": True,
                "workflow_id": planner_workflow_id,
                "message": "Workflow already completed (auto-approved in standard mode)",
            }

        # If status check failed (no Dapr workflow instance), the plan was done
        # via standalone /plan endpoint. Auto-approve since there's no workflow to approve.
        if not status_result.get("success"):
            error_msg = status_result.get("error", "")
            if "no such instance" in error_msg or "not found" in error_msg.lower() or "404" in error_msg or "500" in error_msg:
                logger.info(f"[Planner Workflow] No Dapr workflow instance for {planner_workflow_id} (standalone plan mode), auto-approving")
                return {
                    "success": True,
                    "approved": True,
                    "workflow_id": planner_workflow_id,
                    "message": "Auto-approved (standalone plan mode - no Dapr workflow instance)",
                }

        logger.info(f"[Planner Workflow] {'Approving' if approved else 'Rejecting'} workflow: {planner_workflow_id}")

        result = yield ctx.call_activity(
            call_planner_approve,
            input={
                "planner_workflow_id": planner_workflow_id,
                "approved": approved,
                "reason": reason,
            }
        )

        return result

    elif action_type == "planner/multi-step":
        # Full multi-step workflow: clone → plan → approve → sandbox exec+test
        # Uses planner-dapr-agent /workflow/dapr endpoint
        from activities.call_planner_service import call_planner_multi_step

        logger.info(f"[Planner Workflow] Starting multi-step workflow via /workflow/dapr")

        # Build repository config from resolved fields
        repo_owner = resolved_config.get("repositoryOwner", "")
        repo_name = resolved_config.get("repositoryRepo", "")
        repository = None
        if repo_owner and repo_name:
            repository = {
                "owner": repo_owner,
                "repo": repo_name,
                "branch": _normalize_git_branch(
                    resolved_config.get("repositoryBranch", "main")
                ),
                "token": resolved_config.get("repositoryToken", ""),
            }

        result = yield ctx.call_activity(
            call_planner_multi_step,
            input={
                "workflow_id": ctx.instance_id,
                "feature_request": resolved_config.get("featureRequest", ""),
                "model": resolved_config.get("model", "gpt-5.2-codex"),
                "max_turns": int(resolved_config.get("maxTurns", 20)),
                "max_test_retries": int(resolved_config.get("maxTestRetries", 3)),
                "auto_approve": resolved_config.get("autoApprove") in (True, "true"),
                "repository": repository,
                "connection_external_id": connection_external_id,
                "parent_execution_id": ctx.instance_id,
            },
        )

        return result

    elif action_type == "planner/status":
        # Get workflow status - uses /api/workflows/{id}/status
        from activities.call_planner_service import call_planner_status

        planner_workflow_id = resolved_config.get("plannerWorkflowId", "") or resolved_config.get("workflowId", "")

        logger.info(f"[Planner Workflow] Getting status for workflow: {planner_workflow_id}")

        result = yield ctx.call_activity(
            call_planner_status,
            input={
                "planner_workflow_id": planner_workflow_id,
            }
        )

        return result

    else:
        logger.warning(f"[Planner Workflow] Unknown planner action type: {action_type}")
        return {
            "success": False,
            "error": f"Unknown planner action type: {action_type}",
        }


def process_approval_gate(
    ctx: wf.DaprWorkflowContext,
    node: dict,
    execution_id: str,
    workflow_id: str,
    db_execution_id: str | None,
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
    }))

    # Publish that we're waiting for approval
    yield ctx.call_activity(publish_phase_changed, input={
        "workflowId": workflow_id,
        "executionId": execution_id,
        "phase": "awaiting_approval",
        "progress": 50,
        "message": f"Waiting for approval: {node.get('label')}",
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
        })

    return {
        "approved": approval_result.get("approved", False) if approval_result else False,
        "reason": approval_result.get("reason") if approval_result else None,
        "respondedBy": approval_result.get("respondedBy") if approval_result else None,
    }
