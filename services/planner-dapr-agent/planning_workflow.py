"""Dapr workflow integration for the multi-agent planning system.

This module provides Dapr workflow and activity definitions that integrate
the OpenAI Agents SDK planning orchestrator with Dapr's durable workflow
infrastructure.

The workflow follows this pattern:
1. research_and_plan activity - Runs the async planning orchestrator
2. Workflow waits for approval
3. Returns approved/rejected plan

This provides durability and observability through Dapr while leveraging
the parallel agent execution capabilities of the planning orchestrator.
"""

import asyncio
import json
import logging
import os
import uuid
from datetime import timedelta
from typing import Any, Dict, Optional

from dapr.clients import DaprClient
from dapr.ext import workflow as wf

from planning_models import PlanningRequest, PlanningResult
from planning_orchestrator import run_planning_workflow, create_plan


logger = logging.getLogger(__name__)


# Pub/sub configuration for progress updates
PUBSUB_NAME = os.getenv("PUBSUB_NAME", "pubsub")
PUBSUB_TOPIC = os.getenv("PUBSUB_TOPIC", "workflow.stream")
AGENT_ID = "planner-dapr-agent"


# ============================================================================
# Helper Functions
# ============================================================================


def publish_workflow_event(
    workflow_id: str,
    event_type: str,
    data: Dict[str, Any],
) -> None:
    """Publish a workflow event to the pub/sub topic.

    Args:
        workflow_id: Workflow instance ID
        event_type: Type of event (e.g., "progress", "approval_required")
        data: Event data payload
    """
    try:
        with DaprClient() as client:
            event = {
                "workflowId": workflow_id,
                "agentId": AGENT_ID,
                "eventType": event_type,
                **data,
            }
            client.publish_event(
                pubsub_name=PUBSUB_NAME,
                topic_name=PUBSUB_TOPIC,
                data=json.dumps(event),
                data_content_type="application/json",
            )
            logger.debug(f"Published {event_type} event for workflow {workflow_id}")
    except Exception as e:
        logger.warning(f"Failed to publish workflow event: {e}")


def save_workflow_state(
    workflow_id: str,
    state: Dict[str, Any],
    store_name: str = "statestore",
) -> None:
    """Save workflow state to Dapr state store.

    Args:
        workflow_id: Workflow instance ID
        state: State data to save
        store_name: Name of the state store
    """
    try:
        with DaprClient() as client:
            client.save_state(
                store_name=store_name,
                key=f"planning-workflow:{workflow_id}",
                value=json.dumps(state),
            )
    except Exception as e:
        logger.warning(f"Failed to save workflow state: {e}")


def get_workflow_state(
    workflow_id: str,
    store_name: str = "statestore",
) -> Optional[Dict[str, Any]]:
    """Get workflow state from Dapr state store.

    Args:
        workflow_id: Workflow instance ID
        store_name: Name of the state store

    Returns:
        Workflow state or None if not found
    """
    try:
        with DaprClient() as client:
            state = client.get_state(
                store_name=store_name,
                key=f"planning-workflow:{workflow_id}",
            )
            if state.data:
                return json.loads(state.data)
    except Exception as e:
        logger.warning(f"Failed to get workflow state: {e}")
    return None


# ============================================================================
# Workflow Runtime
# ============================================================================


# Create workflow runtime
wfr = wf.WorkflowRuntime()


def get_planning_workflow_runtime() -> wf.WorkflowRuntime:
    """Get the workflow runtime with registered workflows and activities."""
    return wfr


# ============================================================================
# Workflow Activities
# ============================================================================


@wfr.activity(name="research_and_plan")
def research_and_plan_activity(ctx: wf.WorkflowActivityContext, input_data: Dict) -> Dict:
    """Dapr activity that runs the async planning orchestrator.

    This activity wraps the planning_orchestrator's run_planning_workflow
    function, providing durability through Dapr's activity execution.

    Args:
        ctx: Workflow activity context
        input_data: Dictionary with feature_request, model, workspace_dir, workflow_id

    Returns:
        Planning result with tasks and plan details
    """
    workflow_id = input_data.get("workflow_id", "unknown")
    logger.info(f"Starting research_and_plan activity for workflow {workflow_id}")

    def progress_callback(progress: int, message: str) -> None:
        """Publish progress updates via pub/sub."""
        publish_workflow_event(
            workflow_id,
            "progress",
            {"progress": progress, "message": message},
        )

    try:
        # Run the async planning workflow synchronously
        result = asyncio.run(run_planning_workflow(
            feature_request=input_data["feature_request"],
            model=input_data.get("model", "gpt-4o"),
            workspace_dir=input_data.get("workspace_dir", "/app/workspace"),
            progress_callback=progress_callback,
            max_tasks=input_data.get("max_tasks", 15),
        ))

        logger.info(f"Research and planning completed for workflow {workflow_id}")
        return result

    except Exception as e:
        logger.exception(f"Research and planning failed for workflow {workflow_id}")
        return {
            "success": False,
            "error": str(e),
            "tasks": [],
        }


@wfr.activity(name="persist_plan")
def persist_plan_activity(ctx: wf.WorkflowActivityContext, input_data: Dict) -> Dict:
    """Save the generated plan to the state store.

    Args:
        ctx: Workflow activity context
        input_data: Dictionary with workflow_id and plan data

    Returns:
        Success status
    """
    workflow_id = input_data.get("workflow_id", "unknown")

    try:
        save_workflow_state(workflow_id, {
            "tasks": input_data.get("tasks", []),
            "plan": input_data.get("plan"),
            "phase": "awaiting_approval",
        })

        # Also save tasks separately for easy retrieval
        with DaprClient() as client:
            client.save_state(
                store_name="statestore",
                key=f"tasks:{workflow_id}",
                value=json.dumps(input_data.get("tasks", [])),
            )

        return {"success": True}

    except Exception as e:
        logger.exception(f"Failed to persist plan for workflow {workflow_id}")
        return {"success": False, "error": str(e)}


@wfr.activity(name="notify_approval_required")
def notify_approval_required_activity(ctx: wf.WorkflowActivityContext, input_data: Dict) -> Dict:
    """Send notification that approval is required.

    Args:
        ctx: Workflow activity context
        input_data: Dictionary with workflow_id and task count

    Returns:
        Success status
    """
    workflow_id = input_data.get("workflow_id", "unknown")

    publish_workflow_event(
        workflow_id,
        "approval_required",
        {
            "tasks_count": input_data.get("tasks_count", 0),
            "message": "Planning complete. Please review and approve the tasks.",
        },
    )

    return {"success": True}


# ============================================================================
# Workflow Definition
# ============================================================================


@wfr.workflow(name="planning_workflow")
def planning_workflow(ctx: wf.DaprWorkflowContext, input_data: Dict):
    """Dapr workflow for research-based planning.

    Workflow stages:
    1. Research and Plan - Run parallel agents to analyze codebase and create tasks
    2. Persist Plan - Save tasks to state store
    3. Await Approval - Wait for human approval (24h timeout)
    4. Return Result - Return approved or rejected plan

    Args:
        ctx: Dapr workflow context
        input_data: Dictionary with feature_request, model, workspace_dir

    Yields:
        Workflow activities and events

    Returns:
        Final workflow result with success status and tasks
    """
    workflow_id = ctx.instance_id

    # Phase 1: Research and Planning
    ctx.set_custom_status(json.dumps({
        "phase": "planning",
        "progress": 10,
        "message": "Starting research and planning...",
    }))

    # Add workflow_id to input for activity tracking
    planning_input = {
        **input_data,
        "workflow_id": workflow_id,
    }

    result = yield ctx.call_activity(
        research_and_plan_activity,
        input=planning_input,
    )

    # Check if planning succeeded
    if not result.get("success", False):
        ctx.set_custom_status(json.dumps({
            "phase": "failed",
            "progress": 100,
            "message": f"Planning failed: {result.get('error', 'Unknown error')}",
        }))
        return {
            "success": False,
            "phase": "failed",
            "error": result.get("error"),
        }

    tasks = result.get("tasks", [])
    plan = result.get("plan")

    # Phase 2: Persist Plan
    ctx.set_custom_status(json.dumps({
        "phase": "persisting",
        "progress": 50,
        "message": "Saving plan...",
    }))

    yield ctx.call_activity(
        persist_plan_activity,
        input={
            "workflow_id": workflow_id,
            "tasks": tasks,
            "plan": plan,
        },
    )

    # Phase 3: Await Approval
    ctx.set_custom_status(json.dumps({
        "phase": "awaiting_approval",
        "progress": 55,
        "message": f"Awaiting approval for {len(tasks)} tasks",
        "tasks_count": len(tasks),
    }))

    # Notify that approval is required
    yield ctx.call_activity(
        notify_approval_required_activity,
        input={
            "workflow_id": workflow_id,
            "tasks_count": len(tasks),
        },
    )

    # Wait for approval event (24 hour timeout)
    try:
        approval = yield ctx.wait_for_external_event(
            "approval",
            timeout=timedelta(hours=24),
        )
    except TimeoutError:
        ctx.set_custom_status(json.dumps({
            "phase": "timeout",
            "progress": 100,
            "message": "Approval timeout - workflow expired",
        }))
        return {
            "success": False,
            "phase": "timeout",
            "error": "Approval timeout after 24 hours",
        }

    # Check approval decision
    if not approval.get("approved", False):
        ctx.set_custom_status(json.dumps({
            "phase": "rejected",
            "progress": 100,
            "message": "Plan rejected by user",
        }))
        return {
            "success": False,
            "phase": "rejected",
            "reason": approval.get("reason", "No reason provided"),
        }

    # Phase 4: Approved
    ctx.set_custom_status(json.dumps({
        "phase": "approved",
        "progress": 100,
        "message": "Plan approved",
    }))

    return {
        "success": True,
        "phase": "approved",
        "tasks": tasks,
        "plan": plan,
    }


# ============================================================================
# Workflow Client Helpers
# ============================================================================


def start_planning_workflow(
    feature_request: str,
    model: str = "gpt-4o",
    workspace_dir: str = "/app/workspace",
    workflow_id: Optional[str] = None,
    max_tasks: int = 15,
) -> str:
    """Start a new planning workflow.

    Args:
        feature_request: Description of the feature to implement
        model: OpenAI model to use
        workspace_dir: Path to the workspace
        workflow_id: Optional workflow ID (generated if not provided)
        max_tasks: Maximum number of tasks to generate

    Returns:
        Workflow instance ID
    """
    from dapr.ext.workflow import DaprWorkflowClient

    if workflow_id is None:
        workflow_id = str(uuid.uuid4())

    with DaprWorkflowClient() as client:
        instance_id = client.schedule_new_workflow(
            workflow=planning_workflow,
            input={
                "feature_request": feature_request,
                "model": model,
                "workspace_dir": workspace_dir,
                "max_tasks": max_tasks,
            },
            instance_id=workflow_id,
        )

    logger.info(f"Started planning workflow with ID: {instance_id}")
    return instance_id


def approve_planning_workflow(
    workflow_id: str,
    approved: bool = True,
    reason: Optional[str] = None,
) -> bool:
    """Approve or reject a planning workflow.

    Args:
        workflow_id: Workflow instance ID
        approved: Whether to approve (True) or reject (False)
        reason: Optional reason for rejection

    Returns:
        True if event was raised successfully
    """
    from dapr.ext.workflow import DaprWorkflowClient

    try:
        with DaprWorkflowClient() as client:
            client.raise_workflow_event(
                instance_id=workflow_id,
                event_name="approval",
                data={
                    "approved": approved,
                    "reason": reason,
                },
            )
        logger.info(f"Raised approval event for workflow {workflow_id}: approved={approved}")
        return True
    except Exception as e:
        logger.exception(f"Failed to raise approval event: {e}")
        return False


def get_planning_workflow_status(workflow_id: str) -> Optional[Dict[str, Any]]:
    """Get the status of a planning workflow.

    Args:
        workflow_id: Workflow instance ID

    Returns:
        Workflow status or None if not found
    """
    from dapr.ext.workflow import DaprWorkflowClient

    try:
        with DaprWorkflowClient() as client:
            state = client.get_workflow_state(instance_id=workflow_id)
            if state:
                # Parse custom status if available
                custom_status = None
                if state.runtime_status:
                    try:
                        custom_status = json.loads(state.custom_status) if state.custom_status else None
                    except (json.JSONDecodeError, TypeError):
                        pass

                return {
                    "workflow_id": workflow_id,
                    "runtime_status": state.runtime_status.name if state.runtime_status else "unknown",
                    "custom_status": custom_status,
                    "created_at": state.created_at.isoformat() if state.created_at else None,
                    "last_updated_at": state.last_updated_at.isoformat() if state.last_updated_at else None,
                }
    except Exception as e:
        logger.warning(f"Failed to get workflow status: {e}")
    return None


def get_planning_workflow_tasks(workflow_id: str) -> Optional[list]:
    """Get tasks from a planning workflow.

    Args:
        workflow_id: Workflow instance ID

    Returns:
        List of tasks or None if not found
    """
    try:
        with DaprClient() as client:
            state = client.get_state(
                store_name="statestore",
                key=f"tasks:{workflow_id}",
            )
            if state.data:
                return json.loads(state.data)
    except Exception as e:
        logger.warning(f"Failed to get workflow tasks: {e}")
    return None
