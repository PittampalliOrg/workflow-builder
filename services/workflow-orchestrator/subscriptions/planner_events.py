"""
Planner Events Subscription Handler

Handles pub/sub events from planner-dapr-agent and forwards them as
external events to waiting parent workflows.

Event flow:
1. planner-dapr-agent publishes planner_planning_completed or planner_execution_completed
2. Dapr routes event to this handler via subscription
3. Handler raises external event on parent workflow using parent_execution_id
4. Parent workflow's wait_for_external_event unblocks and receives the data
"""

from __future__ import annotations

import logging
from typing import Any

from dapr.ext.workflow import DaprWorkflowClient
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class PlannerCompletionEvent(BaseModel):
    """CloudEvent payload from planner-dapr-agent completion events."""
    workflow_id: str = Field(..., description="Planner workflow instance ID")
    parent_execution_id: str | None = Field(default=None, description="Parent workflow instance ID")
    phase: str = Field(..., description="Completed phase (planning or execution)")
    success: bool = Field(default=True, description="Whether the phase succeeded")
    tasks: list[dict[str, Any]] = Field(default_factory=list, description="Tasks from planning")
    task_count: int = Field(default=0, description="Number of tasks")
    result: dict[str, Any] = Field(default_factory=dict, description="Execution result")
    error: str | None = Field(default=None, description="Error message if failed")
    timestamp: str | None = Field(default=None, description="Event timestamp")


def handle_planner_event(event_type: str, event_data: dict[str, Any]) -> dict[str, Any]:
    """
    Handle a planner completion event and raise external event on parent workflow.

    This function is called from the FastAPI subscription endpoint.

    The planner-dapr-agent publishes events with the actual type inside the data payload:
    - CloudEvent envelope has type="com.dapr.event.sent"
    - Actual type is in event_data["type"] (e.g., "execution_completed", "agent_started")

    Args:
        event_type: The CloudEvent envelope type (usually "com.dapr.event.sent")
        event_data: The event data payload containing the actual planner event

    Returns:
        Dict with status and details
    """
    # The actual event type is inside the data payload, not in the CloudEvent envelope
    actual_event_type = event_data.get("type", event_type)
    logger.info(f"[Planner Events] Received event: {actual_event_type} (envelope: {event_type})")

    # Only process completion events that have parent workflow routing info
    completion_event_types = {"execution_completed", "planning_completed", "phase_completed"}
    if actual_event_type not in completion_event_types:
        logger.debug(f"[Planner Events] Ignoring non-completion event: {actual_event_type}")
        return {
            "status": "ignored",
            "reason": "not_completion_event",
            "event_type": actual_event_type,
        }

    try:
        # Map planner-dapr-agent event format to our expected format
        # planner-dapr-agent format: {id, type, workflowId, agentId, data, timestamp}
        inner_data = event_data.get("data", {})
        mapped_event = {
            "workflow_id": event_data.get("workflowId", ""),
            "parent_execution_id": inner_data.get("parent_execution_id"),
            "phase": inner_data.get("phase", actual_event_type.replace("_completed", "")),
            "success": inner_data.get("success", True),
            "tasks": inner_data.get("tasks", []),
            "task_count": inner_data.get("task_count", len(inner_data.get("tasks", []))),
            "result": inner_data.get("result", {}),
            "error": inner_data.get("error"),
            "timestamp": event_data.get("timestamp"),
        }

        # Parse the event data
        event = PlannerCompletionEvent(**mapped_event)

        # Check if we have a parent workflow to notify
        if not event.parent_execution_id:
            logger.info(
                f"[Planner Events] No parent_execution_id for workflow {event.workflow_id}, "
                "skipping event forwarding"
            )
            return {
                "status": "ignored",
                "reason": "no_parent_execution_id",
                "workflow_id": event.workflow_id,
            }

        # Determine the external event name based on actual event type
        event_name_mapping = {
            # planner-dapr-agent uses these event types
            "execution_completed": f"planner_execution_{event.workflow_id}",
            "planning_completed": f"planner_planning_{event.workflow_id}",
            "phase_completed": f"planner_phase_{event.workflow_id}",
            # planner-dapr-agent uses these event types
            "planner_planning_completed": f"planner_planning_{event.workflow_id}",
            "planner_execution_completed": f"planner_execution_{event.workflow_id}",
        }

        external_event_name = event_name_mapping.get(actual_event_type)
        if not external_event_name:
            logger.warning(f"[Planner Events] Unknown event type: {actual_event_type}")
            return {
                "status": "ignored",
                "reason": "unknown_event_type",
                "event_type": actual_event_type,
            }

        # Build the event data to send to the parent workflow
        event_payload = {
            "workflow_id": event.workflow_id,
            "phase": event.phase,
            "success": event.success,
            "tasks": event.tasks,
            "task_count": event.task_count,
            "result": event.result,
            "error": event.error,
            "timestamp": event.timestamp,
        }

        # Raise the external event on the parent workflow
        logger.info(
            f"[Planner Events] Raising external event '{external_event_name}' "
            f"on parent workflow: {event.parent_execution_id}"
        )

        client = DaprWorkflowClient()
        client.raise_workflow_event(
            instance_id=event.parent_execution_id,
            event_name=external_event_name,
            data=event_payload,
        )

        logger.info(
            f"[Planner Events] Successfully forwarded {actual_event_type} to parent workflow "
            f"{event.parent_execution_id}"
        )

        return {
            "status": "forwarded",
            "event_type": actual_event_type,
            "external_event_name": external_event_name,
            "parent_execution_id": event.parent_execution_id,
            "workflow_id": event.workflow_id,
        }

    except Exception as e:
        logger.error(f"[Planner Events] Failed to handle event: {e}")
        return {
            "status": "error",
            "error": str(e),
        }
