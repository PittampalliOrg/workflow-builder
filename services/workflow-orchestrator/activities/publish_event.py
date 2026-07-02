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

from content_tracing import io_attributes
from core.config import config
from activities.workflow_data_client import workflow_data_api_mode, workflow_data_client
from .metadata import (
    activity_metadata,
    schema_any_object,
    schema_boolean,
    schema_integer,
    schema_object,
    schema_string,
)
from tracing import set_current_span_attrs, start_activity_span, inject_current_context

logger = logging.getLogger(__name__)

PUBSUB_NAME = config.PUBSUB_NAME
WORKFLOW_EVENTS_TOPIC = "workflow.events"
SECRET_STORE_NAME = "kubernetes-secrets"
SECRET_NAME = "workflow-builder-secrets"

_database_url: str | None = None

PUBLISH_EVENT_INPUT_SCHEMA = schema_object(
    {
        "topic": schema_string(description="Pub/sub topic to publish to.", default=WORKFLOW_EVENTS_TOPIC),
        "eventType": schema_string(description="CloudEvent type."),
        "data": schema_any_object(description="Event payload data."),
        "metadata": schema_any_object(description="Additional CloudEvent extensions."),
    },
    required=["eventType", "data"],
    description="Base workflow event payload.",
)

PUBLISH_EVENT_OUTPUT_SCHEMA = schema_object(
    {
        "success": schema_boolean(description="Whether the event was published.", default=True),
        "topic": schema_string(description="Topic that was targeted."),
        "eventType": schema_string(description="Event type that was published."),
        "error": schema_string(description="Error message when publication fails."),
    },
    description="Result of publishing a workflow event.",
)

PUBLISH_WORKFLOW_STARTED_INPUT_SCHEMA = schema_object(
    {
        "workflowId": schema_string(description="Workflow identifier."),
        "executionId": schema_string(description="Workflow execution identifier."),
        "workflowName": schema_string(description="Human-readable workflow name."),
    },
    required=["workflowId", "executionId", "workflowName"],
    description="Payload for workflow.started.",
)

PUBLISH_WORKFLOW_COMPLETED_INPUT_SCHEMA = schema_object(
    {
        "workflowId": schema_string(description="Workflow identifier."),
        "executionId": schema_string(description="Workflow execution identifier."),
        "outputs": schema_any_object(description="Workflow outputs."),
    },
    required=["workflowId", "executionId"],
    description="Payload for workflow.completed.",
)

PUBLISH_WORKFLOW_FAILED_INPUT_SCHEMA = schema_object(
    {
        "workflowId": schema_string(description="Workflow identifier."),
        "executionId": schema_string(description="Workflow execution identifier."),
        "error": schema_string(description="Failure error."),
    },
    required=["workflowId", "executionId"],
    description="Payload for workflow.failed.",
)

PUBLISH_PHASE_CHANGED_INPUT_SCHEMA = schema_object(
    {
        "workflowId": schema_string(description="Workflow identifier."),
        "executionId": schema_string(description="Workflow execution identifier."),
        "phase": schema_string(description="Current workflow phase."),
        "progress": schema_integer(description="Progress percentage.", minimum=0, default=0),
        "message": schema_string(description="Optional progress message."),
    },
    required=["workflowId", "executionId", "phase"],
    description="Payload for workflow.phase.changed.",
)

PUBLISH_APPROVAL_REQUESTED_INPUT_SCHEMA = schema_object(
    {
        "workflowId": schema_string(description="Workflow identifier."),
        "executionId": schema_string(description="Workflow execution identifier."),
        "nodeId": schema_string(description="Node identifier."),
        "nodeName": schema_string(description="Node name."),
        "eventName": schema_string(description="Approval event name."),
        "timeoutSeconds": schema_integer(description="Timeout in seconds.", minimum=1, default=86400),
    },
    required=["workflowId", "executionId", "nodeId", "nodeName", "eventName"],
    description="Payload for workflow.approval.requested.",
)

PUBLISH_EVENT_METADATA_OUTPUT_SCHEMA = PUBLISH_EVENT_OUTPUT_SCHEMA


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


def _get_database_url() -> str:
    """Fetch DATABASE_URL from Dapr secrets store (cached)."""
    global _database_url
    if _database_url is not None:
        return _database_url

    with DaprClient() as client:
        secret = client.get_secret(store_name=SECRET_STORE_NAME, key=SECRET_NAME)
        db_url = secret.secret.get("DATABASE_URL")
    if not db_url:
        raise RuntimeError(
            f"DATABASE_URL not found in secret '{SECRET_NAME}' from store '{SECRET_STORE_NAME}'"
        )

    _database_url = db_url
    return db_url


def _persist_execution_phase(
    execution_id: str | None,
    phase: Any,
    progress: Any,
) -> None:
    if not execution_id:
        return

    api_mode = workflow_data_api_mode()
    if api_mode != "postgres":
        try:
            workflow_data_client.patch_execution(
                execution_id,
                {
                    "phase": str(phase) if phase is not None else None,
                    "progress": int(progress) if progress is not None else None,
                },
            )
            return
        except Exception:
            if api_mode == "http":
                raise
            logger.exception(
                "[Publish Event] workflow-data phase update failed; falling back to Postgres"
            )

    import psycopg2

    db_url = _get_database_url()
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE workflow_executions
                SET
                    phase = %s,
                    progress = %s
                WHERE id = %s
                """,
                (
                    str(phase) if phase is not None else None,
                    int(progress) if progress is not None else None,
                    execution_id,
                ),
            )
        conn.commit()
    finally:
        conn.close()


@activity_metadata(
    public_callable=True,
    display_name="Publish Event",
    description="Publish a workflow event to Dapr pub/sub.",
    category="events",
    tags=("pubsub", "workflow"),
    sw_name="publish_event",
    input_schema=PUBLISH_EVENT_INPUT_SCHEMA,
    output_schema=PUBLISH_EVENT_OUTPUT_SCHEMA,
)
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
                set_current_span_attrs(
                    {
                        "messaging.system": "dapr",
                        "messaging.destination.name": topic,
                        **io_attributes("input", event_payload),
                    }
                )

                client.publish_event(
                    pubsub_name=PUBSUB_NAME,
                    topic_name=topic,
                    data=json.dumps(event_payload),
                    data_content_type="application/json",
                )

            logger.info(f"[Publish Event] Successfully published {event_type} to {topic}")

            result = {
                "success": True,
                "topic": topic,
                "eventType": event_type,
            }
            set_current_span_attrs(io_attributes("output", result))
            return result

        except Exception as e:
            error_msg = str(e)
            logger.error(f"[Publish Event] Failed to publish {event_type} to {topic}: {e}")

            result = {
                "success": False,
                "topic": topic,
                "eventType": event_type,
                "error": f"Failed to publish event: {error_msg}",
            }
            set_current_span_attrs(io_attributes("output", result))
            return result


@activity_metadata(
    public_callable=True,
    display_name="Publish Workflow Started",
    description="Publish the workflow.started event.",
    category="events",
    tags=("pubsub", "workflow"),
    sw_name="publish_workflow_started",
    input_schema=PUBLISH_WORKFLOW_STARTED_INPUT_SCHEMA,
    output_schema=PUBLISH_EVENT_METADATA_OUTPUT_SCHEMA,
)
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


@activity_metadata(
    public_callable=True,
    display_name="Publish Workflow Completed",
    description="Publish the workflow.completed event.",
    category="events",
    tags=("pubsub", "workflow"),
    sw_name="publish_workflow_completed",
    input_schema=PUBLISH_WORKFLOW_COMPLETED_INPUT_SCHEMA,
    output_schema=PUBLISH_EVENT_METADATA_OUTPUT_SCHEMA,
)
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


@activity_metadata(
    public_callable=True,
    display_name="Publish Workflow Failed",
    description="Publish the workflow.failed event.",
    category="events",
    tags=("pubsub", "workflow"),
    sw_name="publish_workflow_failed",
    input_schema=PUBLISH_WORKFLOW_FAILED_INPUT_SCHEMA,
    output_schema=PUBLISH_EVENT_METADATA_OUTPUT_SCHEMA,
)
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


@activity_metadata(
    public_callable=True,
    display_name="Publish Phase Changed",
    description="Persist and publish a workflow phase change event.",
    category="events",
    tags=("pubsub", "workflow"),
    sw_name="publish_phase_changed",
    input_schema=PUBLISH_PHASE_CHANGED_INPUT_SCHEMA,
    output_schema=PUBLISH_EVENT_METADATA_OUTPUT_SCHEMA,
)
def publish_phase_changed(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Publish a phase change event."""
    execution_id = input_data.get("executionId")
    phase = input_data.get("phase")
    progress = input_data.get("progress", 0)

    try:
        _persist_execution_phase(
            str(execution_id).strip() if execution_id is not None else None,
            phase,
            progress,
        )
    except Exception as exc:
        logger.warning(
            "[Publish Event] Failed to persist execution phase for %s: %s",
            execution_id,
            exc,
        )

    return publish_event(ctx, {
        "topic": WORKFLOW_EVENTS_TOPIC,
        "eventType": WorkflowEventTypes.WORKFLOW_PHASE_CHANGED,
        "data": {
            "workflowId": input_data.get("workflowId"),
            "executionId": execution_id,
            "phase": phase,
            "progress": progress,
            "message": input_data.get("message"),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
    })


@activity_metadata(
    public_callable=True,
    display_name="Publish Approval Requested",
    description="Publish an approval-requested workflow event.",
    category="events",
    tags=("pubsub", "workflow"),
    sw_name="publish_approval_requested",
    input_schema=PUBLISH_APPROVAL_REQUESTED_INPUT_SCHEMA,
    output_schema=PUBLISH_EVENT_METADATA_OUTPUT_SCHEMA,
)
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
