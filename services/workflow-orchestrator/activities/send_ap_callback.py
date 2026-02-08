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

logger = logging.getLogger(__name__)


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
