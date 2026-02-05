"""
Log External Event Activity

Persists external event records (approval requests, responses, timeouts)
to the database for audit trail purposes.

Uses Dapr service invocation to call function-router which has database access.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Literal

import requests

logger = logging.getLogger(__name__)

DAPR_HOST = os.environ.get("DAPR_HOST", "localhost")
DAPR_HTTP_PORT = os.environ.get("DAPR_HTTP_PORT", "3500")
FUNCTION_ROUTER_APP_ID = os.environ.get("FUNCTION_ROUTER_APP_ID", "function-router")

ExternalEventType = Literal["approval_request", "approval_response", "timeout"]


def log_external_event(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Log an external event to the database.

    This activity calls the function-router's /external-event endpoint
    to persist the event record.

    Args:
        ctx: Dapr workflow context (not used but required by Dapr)
        input_data: Dict with event details

    Returns:
        Dict with success status and event_id
    """
    execution_id = input_data.get("executionId", "")
    node_id = input_data.get("nodeId", "")
    event_name = input_data.get("eventName", "")
    event_type = input_data.get("eventType", "")

    logger.info(
        f"[Log External Event] Logging {event_type} for event: {event_name} "
        f"(execution: {execution_id})"
    )

    try:
        url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/{FUNCTION_ROUTER_APP_ID}/method/external-event"

        request_payload = {
            "execution_id": execution_id,
            "node_id": node_id,
            "event_name": event_name,
            "event_type": event_type,
            "timeout_seconds": input_data.get("timeoutSeconds"),
            "approved": input_data.get("approved"),
            "reason": input_data.get("reason"),
            "responded_by": input_data.get("respondedBy"),
            "payload": input_data.get("payload"),
        }

        response = requests.post(url, json=request_payload, timeout=30)
        response.raise_for_status()

        result = response.json()

        if not result.get("success"):
            logger.warning(
                f"[Log External Event] Failed to log {event_type}: {result.get('error')}"
            )
            return {
                "success": False,
                "error": result.get("error"),
            }

        logger.info(
            f"[Log External Event] Successfully logged {event_type}: {result.get('event_id')}"
        )

        return {
            "success": True,
            "eventId": result.get("event_id"),
        }

    except Exception as e:
        error_msg = str(e)
        logger.error(f"[Log External Event] Error logging {event_type}: {e}")

        # Don't throw - audit logging failure shouldn't break workflow execution
        return {
            "success": False,
            "error": f"Failed to log external event: {error_msg}",
        }


def log_approval_request(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Helper to log an approval request event."""
    return log_external_event(ctx, {
        "executionId": input_data.get("executionId"),
        "nodeId": input_data.get("nodeId"),
        "eventName": input_data.get("eventName"),
        "eventType": "approval_request",
        "timeoutSeconds": input_data.get("timeoutSeconds"),
    })


def log_approval_response(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Helper to log an approval response event."""
    return log_external_event(ctx, {
        "executionId": input_data.get("executionId"),
        "nodeId": input_data.get("nodeId"),
        "eventName": input_data.get("eventName"),
        "eventType": "approval_response",
        "approved": input_data.get("approved"),
        "reason": input_data.get("reason"),
        "respondedBy": input_data.get("respondedBy"),
        "payload": input_data.get("payload"),
    })


def log_approval_timeout(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Helper to log a timeout event."""
    timeout_seconds = input_data.get("timeoutSeconds", 0)
    return log_external_event(ctx, {
        "executionId": input_data.get("executionId"),
        "nodeId": input_data.get("nodeId"),
        "eventName": input_data.get("eventName"),
        "eventType": "timeout",
        "timeoutSeconds": timeout_seconds,
        "reason": f"Timed out after {timeout_seconds} seconds",
    })
