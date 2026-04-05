"""
Send AP Callback Activities

Dapr activities for sending HTTP callbacks to the Activepieces server.
These replace inline requests.post() calls that were previously inside
the workflow function (which is a Dapr violation — workflow functions
must be deterministic and free of I/O).

Activities are safe for I/O because Dapr only executes them once and
caches their results for replay.
"""

from __future__ import annotations

import logging
from typing import Any

import requests

from .metadata import (
    activity_metadata,
    schema_any_object,
    schema_boolean,
    schema_integer,
    schema_object,
    schema_string,
)

logger = logging.getLogger(__name__)

SEND_AP_CALLBACK_INPUT_SCHEMA = schema_object(
    {
        "callbackUrl": schema_string(description="Full Activepieces callback URL."),
        "payload": schema_any_object(description="Callback payload."),
    },
    required=["callbackUrl", "payload"],
    description="Payload for sending a flow callback to Activepieces.",
)

SEND_AP_CALLBACK_OUTPUT_SCHEMA = schema_object(
    {
        "success": schema_boolean(description="Whether the callback succeeded.", default=True),
        "skipped": schema_boolean(description="Whether the callback was intentionally skipped."),
        "error": schema_string(description="Error message when callback fails."),
        "statusCode": schema_integer(description="HTTP status returned by the callback endpoint."),
    },
    description="Result of sending a callback to Activepieces.",
)


@activity_metadata(
    public_callable=True,
    display_name="Send AP Callback",
    description="Send a flow-level callback to Activepieces.",
    category="integrations",
    tags=("activepieces", "callback"),
    sw_name="send_ap_callback",
    input_schema=SEND_AP_CALLBACK_INPUT_SCHEMA,
    output_schema=SEND_AP_CALLBACK_OUTPUT_SCHEMA,
)
def send_ap_callback(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Activity: POST to AP's /api/v1/dapr/flow-run-callback.

    Sends flow-level status updates (RUNNING, SUCCEEDED, FAILED, PAUSED)
    to the Activepieces server so it can update its flow_run record.

    Args:
        ctx: Dapr activity context (unused but required)
        input_data:
            callbackUrl: str - Full URL to AP callback endpoint
            payload: dict - Callback payload (flowRunId, status, steps, etc.)

    Returns:
        {"success": True} on success, {"success": False, "error": ...} on failure
    """
    callback_url = input_data.get('callbackUrl', '')
    payload = input_data.get('payload', {})

    if not callback_url:
        logger.warning("[APCallback] No callback URL provided, skipping")
        return {"success": True, "skipped": True}

    try:
        logger.info(
            f"[APCallback] Sending callback: status={payload.get('status')}, "
            f"flowRunId={payload.get('flowRunId')}"
        )

        response = requests.post(
            callback_url,
            json=payload,
            timeout=10,
        )

        if response.status_code >= 400:
            logger.warning(
                f"[APCallback] Callback returned {response.status_code}: {response.text[:200]}"
            )
            return {
                "success": False,
                "error": f"Callback returned HTTP {response.status_code}",
                "statusCode": response.status_code,
            }

        return {"success": True}

    except requests.Timeout:
        logger.warning("[APCallback] Callback timed out")
        return {"success": False, "error": "Callback timed out"}

    except Exception as e:
        logger.warning(f"[APCallback] Failed to send callback: {e}")
        return {"success": False, "error": str(e)}


@activity_metadata(
    public_callable=True,
    display_name="Send AP Step Update",
    description="Send a per-step progress update to Activepieces.",
    category="integrations",
    tags=("activepieces", "callback"),
    sw_name="send_ap_step_update",
    input_schema=SEND_AP_CALLBACK_INPUT_SCHEMA,
    output_schema=SEND_AP_CALLBACK_OUTPUT_SCHEMA,
)
def send_ap_step_update(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Activity: POST to AP's /api/v1/dapr/flow-run-step-update.

    Sends per-step progress updates to AP so the run viewer can show
    incremental step completions as they happen.

    Args:
        ctx: Dapr activity context (unused but required)
        input_data:
            callbackUrl: str - Base callback URL (flow-run-callback)
            payload: dict - Step update payload (flowRunId, stepName, stepOutput)

    Returns:
        {"success": True} on success, {"success": False, "error": ...} on failure
    """
    callback_url = input_data.get('callbackUrl', '')
    payload = input_data.get('payload', {})

    if not callback_url:
        logger.warning("[APStepUpdate] No callback URL provided, skipping")
        return {"success": True, "skipped": True}

    # Derive step-update URL from the callback URL
    step_update_url = callback_url.replace(
        '/flow-run-callback', '/flow-run-step-update'
    )

    try:
        logger.debug(
            f"[APStepUpdate] Sending step update: step={payload.get('stepName')}"
        )

        response = requests.post(
            step_update_url,
            json=payload,
            timeout=10,
        )

        if response.status_code >= 400:
            logger.warning(
                f"[APStepUpdate] Step update returned {response.status_code}: {response.text[:200]}"
            )
            return {
                "success": False,
                "error": f"Step update returned HTTP {response.status_code}",
            }

        return {"success": True}

    except requests.Timeout:
        logger.warning("[APStepUpdate] Step update timed out")
        return {"success": False, "error": "Step update timed out"}

    except Exception as e:
        logger.warning(f"[APStepUpdate] Failed to send step update: {e}")
        return {"success": False, "error": str(e)}
