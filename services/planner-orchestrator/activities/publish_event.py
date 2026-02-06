"""Publish event activity - publishes workflow events to Dapr pub/sub."""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from dapr.clients import DaprClient


logger = logging.getLogger(__name__)

PUBSUB_NAME = os.environ.get("PUBSUB_NAME", "pubsub")
PUBSUB_TOPIC = os.environ.get("PUBSUB_TOPIC", "workflow.stream")
# Topic for inter-orchestrator communication (planner → workflow-orchestrator)
WORKFLOW_EVENTS_TOPIC = os.environ.get("WORKFLOW_EVENTS_TOPIC", "workflow.events")


def publish_event(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Publish a workflow stream event to the Dapr pub/sub topic.

    This activity is called at key workflow phase transitions to push
    real-time updates through the SSE pipeline:
      orchestrator → pub/sub → ai-chatbot webhook → Redis → SSE → browser

    Event format matches ai-chatbot's WorkflowStreamEvent interface.
    """
    workflow_id = input_data["workflow_id"]
    event_type = input_data["event_type"]
    data = input_data.get("data", {})
    task_id = input_data.get("task_id")
    agent_id = input_data.get("agent_id", "claude-planner")

    event = {
        "id": f"orch-{workflow_id}-{uuid.uuid4().hex[:8]}",
        "type": event_type,
        "workflowId": workflow_id,
        "agentId": agent_id,
        "data": data,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    if task_id:
        event["taskId"] = task_id

    try:
        with DaprClient() as client:
            client.publish_event(
                pubsub_name=PUBSUB_NAME,
                topic_name=PUBSUB_TOPIC,
                data=json.dumps(event),
                data_content_type="application/json",
            )
        logger.info(
            f"Published {event_type} event for workflow {workflow_id} "
            f"to {PUBSUB_NAME}/{PUBSUB_TOPIC}"
        )
        return {"success": True, "event_id": event["id"]}
    except Exception as e:
        # Non-fatal: event publishing failure shouldn't break the workflow
        logger.warning(
            f"Failed to publish {event_type} event for workflow {workflow_id}: {e}"
        )
        return {"success": False, "error": str(e)}


def publish_planner_completion_event(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Publish a planner phase completion event for parent workflow orchestration.

    This activity publishes events to the workflow.events topic to notify
    the parent workflow-orchestrator when planner phases complete.
    The parent workflow can then use wait_for_external_event to receive
    the completion notification.

    Event types:
    - planner_planning_completed: Planning phase finished (tasks created)
    - planner_execution_completed: Execution phase finished

    Args:
        input_data:
            - workflow_id: The planner workflow instance ID
            - parent_execution_id: The parent workflow instance ID (for routing)
            - event_type: "planner_planning_completed" or "planner_execution_completed"
            - phase: Current phase name
            - success: Whether the phase succeeded
            - tasks: List of tasks (for planning completion)
            - task_count: Number of tasks
            - result: Execution result (for execution completion)
            - error: Error message if failed
    """
    workflow_id = input_data["workflow_id"]
    parent_execution_id = input_data.get("parent_execution_id")
    event_type = input_data["event_type"]
    phase = input_data.get("phase", "unknown")
    success = input_data.get("success", True)
    tasks = input_data.get("tasks", [])
    task_count = input_data.get("task_count", len(tasks))
    result = input_data.get("result", {})
    error = input_data.get("error")

    event = {
        "id": f"planner-{workflow_id}-{uuid.uuid4().hex[:8]}",
        "type": event_type,
        "source": "planner-orchestrator",
        "specversion": "1.0",
        "datacontenttype": "application/json",
        "time": datetime.now(timezone.utc).isoformat(),
        "data": {
            "workflow_id": workflow_id,
            "parent_execution_id": parent_execution_id,
            "phase": phase,
            "success": success,
            "tasks": tasks,
            "task_count": task_count,
            "result": result,
            "error": error,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    }

    try:
        with DaprClient() as client:
            client.publish_event(
                pubsub_name=PUBSUB_NAME,
                topic_name=WORKFLOW_EVENTS_TOPIC,
                data=json.dumps(event),
                data_content_type="application/json",
            )
        logger.info(
            f"Published {event_type} event for planner workflow {workflow_id} "
            f"(parent: {parent_execution_id}) to {PUBSUB_NAME}/{WORKFLOW_EVENTS_TOPIC}"
        )
        return {"success": True, "event_id": event["id"]}
    except Exception as e:
        # Non-fatal: event publishing failure shouldn't break the workflow
        logger.warning(
            f"Failed to publish {event_type} event for planner workflow {workflow_id}: {e}"
        )
        return {"success": False, "error": str(e)}
