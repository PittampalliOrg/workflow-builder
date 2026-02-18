"""
Publish Event Activity

Publishes events to Dapr pub/sub for workflow phase transitions
and inter-service communication.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from dapr.clients import DaprClient

from core.config import config
from tracing import start_activity_span, inject_current_context

logger = logging.getLogger(__name__)

PUBSUB_NAME = config.PUBSUB_NAME
WORKFLOW_EVENTS_TOPIC = "workflow.events"


class WorkflowEventTypes:
    """Workflow event type constants."""
    WORKFLOW_STARTED = "workflow.started"
    WORKFLOW_COMPLETED = "workflow.completed"
    WORKFLOW_FAILED = "workflow.failed"
    WORKFLOW_PHASE_CHANGED = "workflow.phase.changed"
    NODE_STARTED = "workflow.node.started"
    NODE_COMPLETED = "workflow.node.completed"
    NODE_FAILED = "workflow.node.failed"
    APPROVAL_REQUESTED = "workflow.approval.requested"
    APPROVAL_RECEIVED = "workflow.approval.received"


def publish_event(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Publish an event to the specified topic.

    Args:
        ctx: Dapr workflow context (not used but required by Dapr)
        input_data: Dict with topic, eventType, data, metadata (optional)

    Returns:
        Dict with success status, topic, eventType
    """
    topic = input_data.get("topic", WORKFLOW_EVENTS_TOPIC)
    event_type = input_data.get("eventType", "custom")
    data = input_data.get("data", {})
    metadata = input_data.get("metadata", {})
    otel = input_data.get("_otel") or {}

    logger.info(f"[Publish Event] Publishing {event_type} to topic: {topic}")

    attrs = {"action.type": "pubsub/publish", "pubsub.topic": topic, "event.type": event_type}

    with start_activity_span("activity.publish_event", otel, attrs):
        try:
            with DaprClient() as client:
                # Propagate trace context via CloudEvent extensions so downstream
                # consumers can join traces even if they are not HTTP-invoked.
                trace_ctx = inject_current_context()

                event_payload = {
                    "type": event_type,
                    "source": "workflow-orchestrator",
                    "data": data,
                    "time": datetime.now(timezone.utc).isoformat(),
                    "specversion": "1.0",
                    "datacontenttype": "application/json",
                    **(trace_ctx or {}),
                    **metadata,
                }

                client.publish_event(
                    pubsub_name=PUBSUB_NAME,
                    topic_name=topic,
                    data=json.dumps(event_payload),
                    data_content_type="application/json",
                )

            logger.info(f"[Publish Event] Successfully published {event_type} to {topic}")

            return {
                "success": True,
                "topic": topic,
                "eventType": event_type,
            }

        except Exception as e:
            error_msg = str(e)
            logger.error(f"[Publish Event] Failed to publish {event_type} to {topic}: {e}")

            return {
                "success": False,
                "topic": topic,
                "eventType": event_type,
                "error": f"Failed to publish event: {error_msg}",
            }


def publish_workflow_started(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Publish a workflow started event."""
    return publish_event(ctx, {
        "topic": WORKFLOW_EVENTS_TOPIC,
        "eventType": WorkflowEventTypes.WORKFLOW_STARTED,
        "data": {
            "workflowId": input_data.get("workflowId"),
            "executionId": input_data.get("executionId"),
            "workflowName": input_data.get("workflowName"),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    })


def publish_workflow_completed(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Publish a workflow completed event."""
    return publish_event(ctx, {
        "topic": WORKFLOW_EVENTS_TOPIC,
        "eventType": WorkflowEventTypes.WORKFLOW_COMPLETED,
        "data": {
            "workflowId": input_data.get("workflowId"),
            "executionId": input_data.get("executionId"),
            "outputs": input_data.get("outputs", {}),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    })


def publish_workflow_failed(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Publish a workflow failed event."""
    return publish_event(ctx, {
        "topic": WORKFLOW_EVENTS_TOPIC,
        "eventType": WorkflowEventTypes.WORKFLOW_FAILED,
        "data": {
            "workflowId": input_data.get("workflowId"),
            "executionId": input_data.get("executionId"),
            "error": input_data.get("error"),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    })


def publish_phase_changed(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Publish a phase change event."""
    return publish_event(ctx, {
        "topic": WORKFLOW_EVENTS_TOPIC,
        "eventType": WorkflowEventTypes.WORKFLOW_PHASE_CHANGED,
        "data": {
            "workflowId": input_data.get("workflowId"),
            "executionId": input_data.get("executionId"),
            "phase": input_data.get("phase"),
            "progress": input_data.get("progress", 0),
            "message": input_data.get("message"),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    })


def publish_approval_requested(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Publish an approval requested event."""
    timeout_seconds = input_data.get("timeoutSeconds", 86400)
    return publish_event(ctx, {
        "topic": WORKFLOW_EVENTS_TOPIC,
        "eventType": WorkflowEventTypes.APPROVAL_REQUESTED,
        "data": {
            "workflowId": input_data.get("workflowId"),
            "executionId": input_data.get("executionId"),
            "nodeId": input_data.get("nodeId"),
            "nodeName": input_data.get("nodeName"),
            "eventName": input_data.get("eventName"),
            "timeoutSeconds": timeout_seconds,
            "expiresAt": datetime.fromtimestamp(
                datetime.now(timezone.utc).timestamp() + timeout_seconds,
                tz=timezone.utc
            ).isoformat(),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    })
