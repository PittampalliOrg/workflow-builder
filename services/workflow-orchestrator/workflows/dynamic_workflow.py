"""
Dynamic Workflow Interpreter with Child Workflow Support

A single workflow function that interprets and executes any WorkflowDefinition.
Instead of generating separate workflow code for each definition, this interpreter
walks through the definition's execution order and handles each node type dynamically.

KEY FEATURE: Native multi-app child workflow support for planner/* actions.
When a node's actionType starts with "planner/", the workflow invokes the
planner-orchestrator's workflow as a true child workflow using Dapr's
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

logger = logging.getLogger(__name__)

# Create workflow runtime
wfr = wf.WorkflowRuntime()


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


@wfr.workflow(name="dynamic_workflow")
def dynamic_workflow(ctx: wf.DaprWorkflowContext, input_data: dict) -> dict:
    """
    Dynamic Workflow - The main interpreter function

    This workflow function interprets a WorkflowDefinition and executes
    each node in the specified execution order.

    Supports:
    - Action nodes: Regular function execution via function-router
    - Planner child workflows: planner/* actions invoke planner-orchestrator
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

    start_time = time.time()
    execution_id = ctx.instance_id
    workflow_id = definition.get("id", "unknown")

    logger.info(f"[Dynamic Workflow] Starting workflow: {definition.get('name')} ({execution_id})")

    # Initialize node outputs with trigger data
    node_outputs: NodeOutputs = {
        "trigger": {"label": "Trigger", "data": trigger_data}
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
                action_type = config.get("actionType", "")

                # Check if this is a planner child workflow
                if action_type.startswith("planner/"):
                    node_result = yield from process_planner_child_workflow(
                        ctx, node, node_outputs, action_type, integrations, db_execution_id
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
                result = yield from process_approval_gate(
                    ctx, node, execution_id, workflow_id, db_execution_id
                )
                node_result = result

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

                yield ctx.create_timer(timedelta(seconds=duration_seconds))

                logger.info(f"[Dynamic Workflow] Timer completed: {node.get('label')}")
                node_result = {"completed": True}

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

            # Store node output
            node_outputs[node.get("id")] = {
                "label": node.get("label"),
                "data": node_result,
            }

            completed_nodes += 1

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
):
    """
    Invoke planner-dapr-agent workflow via Dapr service invocation.

    The planner-dapr-agent service uses OpenAI Agents SDK for planning
    and execution with features like:
    - Clone repository
    - AI-powered planning with task creation
    - Human approval gates
    - Automated execution

    Supported action types:
    - planner/run-workflow: Full multi-step workflow (clone → plan → approve → execute)
    - planner/plan: Just the planning phase (returns tasks)
    - planner/execute: Continue execution after approval
    - planner/approve: Approve or reject a plan
    - planner/status: Get workflow status

    Args:
        ctx: Dapr workflow context
        node: The action node
        node_outputs: Current node outputs for template resolution
        action_type: The planner action type (e.g., "planner/run-workflow")
        integrations: User's integration credentials
        db_execution_id: Database execution ID for logging

    Yields:
        Activity calls to planner-dapr-agent

    Returns:
        Result from planner workflow
    """
    config = node.get("config") or {}
    resolved_config = resolve_templates(config, node_outputs)

    logger.info(f"[Planner Workflow] Invoking {action_type} on planner-dapr-agent")

    if action_type == "planner/run-workflow":
        # Full multi-step workflow: clone → plan → approve → execute
        # Uses /workflow/dapr endpoint
        from activities.call_planner_service import call_planner_workflow

        logger.info(f"[Planner Workflow] Starting full workflow via /workflow/dapr")

        result = yield ctx.call_activity(
            call_planner_workflow,
            input={
                "workflow_id": ctx.instance_id,
                "feature_request": resolved_config.get("featureRequest", ""),
                "cwd": resolved_config.get("cwd", "/workspace"),
                "repo_url": resolved_config.get("repoUrl", ""),
                "auto_approve": resolved_config.get("autoApprove", False),
            }
        )

        logger.info(f"[Planner Workflow] Full workflow result: success={result.get('success')}")
        return result

    elif action_type == "planner/plan":
        # Just planning phase - uses /run endpoint with durable mode
        from activities.call_planner_service import call_planner_plan

        logger.info(f"[Planner Workflow] Starting planning via /run endpoint")

        result = yield ctx.call_activity(
            call_planner_plan,
            input={
                "workflow_id": ctx.instance_id,
                "feature_request": resolved_config.get("featureRequest", ""),
                "cwd": resolved_config.get("cwd", "/workspace"),
                "repo_url": resolved_config.get("repoUrl", ""),
            }
        )

        logger.info(f"[Planner Workflow] Planning result: {result.get('taskCount', 0)} tasks")
        return result

    elif action_type == "planner/execute":
        # Continue execution after approval - uses /continue/{workflow_id}
        from activities.call_planner_service import call_planner_execute

        planner_workflow_id = resolved_config.get("plannerWorkflowId", "")
        if not planner_workflow_id:
            # Try to get from previous node output
            for node_id, output in node_outputs.items():
                data = output.get("data", {})
                if isinstance(data, dict) and data.get("workflow_id"):
                    planner_workflow_id = data["workflow_id"]
                    break

        logger.info(f"[Planner Workflow] Continuing execution for workflow: {planner_workflow_id}")

        result = yield ctx.call_activity(
            call_planner_execute,
            input={
                "planner_workflow_id": planner_workflow_id,
                "tasks": resolved_config.get("tasks", []),
            }
        )

        logger.info(f"[Planner Workflow] Execution result: success={result.get('success')}")
        return result

    elif action_type == "planner/approve":
        # Approve or reject a plan - uses /workflow/{id}/approve
        from activities.call_planner_service import call_planner_approve

        planner_workflow_id = resolved_config.get("plannerWorkflowId", "")
        approved = resolved_config.get("approved", True)
        reason = resolved_config.get("reason", "")

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

    elif action_type == "planner/status":
        # Get workflow status - uses /workflows/{id}
        from activities.call_planner_service import call_planner_status

        planner_workflow_id = resolved_config.get("plannerWorkflowId", "")

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
