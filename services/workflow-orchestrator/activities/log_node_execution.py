"""
Log Node Execution Activity

Persists execution logs for agent nodes through the workflow-data API. Regular
action nodes are already logged by function-router; this activity fills the gap
for agent nodes that bypass function-router.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from activities.workflow_data_client import workflow_data_client

logger = logging.getLogger(__name__)


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def log_node_start(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Insert a 'running' row into workflow_execution_logs.

    Called before an agent node begins execution.

    Args:
        ctx: Dapr workflow context (required by Dapr, not used)
        input_data: Dict with keys:
            - executionId: DB execution ID (workflow_executions.id)
            - nodeId: Node ID in the workflow
            - nodeName: Display name of the node
            - nodeType: Node type (e.g., "action")
            - actionType: Function slug (e.g., "agent/mastra-run")
            - input: Input data (dict) passed to the node

    Returns:
        Dict with success status and logId (the inserted row's ID)
    """
    execution_id = input_data.get("executionId", "")
    node_id = input_data.get("nodeId", "")
    node_name = input_data.get("nodeName", "")
    node_type = input_data.get("nodeType", "action")
    action_type = input_data.get("actionType", "")
    node_input = input_data.get("input")

    logger.info(
        f"[Log Node Execution] START {action_type} "
        f"(node: {node_name}, execution: {execution_id})"
    )

    log_id = str(uuid.uuid4())

    try:
        workflow_data_client.append_execution_log(
            execution_id,
            {
                "id": log_id,
                "nodeId": node_id,
                "nodeName": node_name,
                "nodeType": node_type,
                "activityName": action_type,
                "status": "running",
                "input": node_input,
                "startedAt": _iso_now(),
            },
        )
        logger.info(f"[Log Node Execution] Inserted running log via workflow-data: {log_id}")
        return {"success": True, "logId": log_id}

    except Exception as e:
        logger.error("[Log Node Execution] workflow-data log_node_start failed: %s", e)
        return {"success": False, "logId": log_id, "error": str(e)}


def update_execution_node(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Push the currently-executing node onto workflow_executions so the DB
    read-model is fresh at every task start — independent of whether anything
    polls the orchestrator status.

    `set_custom_status` already advances the Dapr runtime custom status each
    task, but the DB `current_node_id`/`current_node_name` columns are otherwise
    only synced lazily by the BFF read-model reconcile (on status/run-detail
    fetch). For API-triggered or unattended runs nothing triggers that reconcile,
    so the columns go stale (observed: frozen at an earlier node through the
    approval gate, breaking run-detail UI + automation that keys on the node).
    This best-effort per-task UPDATE keeps them authoritative.

    Args:
        input_data: { executionId, nodeId, nodeName }
    """
    execution_id = input_data.get("executionId", "")
    node_id = input_data.get("nodeId", "")
    node_name = input_data.get("nodeName", "")
    if not execution_id:
        return {"success": False}
    try:
        workflow_data_client.patch_execution(
            execution_id,
            {
                "currentNodeId": node_id,
                "currentNodeName": node_name,
            },
        )
        return {"success": True}
    except Exception as e:  # noqa: BLE001 — logging must never break the workflow
        logger.warning("[Update Execution Node] workflow-data update failed: %s", e)
        return {"success": False, "error": str(e)}


def log_node_complete(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Update the execution log row with completion status, output, and duration.

    Called after an agent node finishes (success or error).

    Args:
        ctx: Dapr workflow context (required by Dapr, not used)
        input_data: Dict with keys:
            - logId: The log row ID returned by log_node_start
            - status: Final status ("success" or "error")
            - output: Output data (dict) from the node
            - error: Error message (if status is "error")
            - durationMs: Execution duration in milliseconds

    Returns:
        Dict with success status
    """
    execution_id = input_data.get("executionId", "")
    log_id = input_data.get("logId", "")
    status = input_data.get("status", "success")
    output = input_data.get("output")
    error = input_data.get("error")
    duration_ms = input_data.get("durationMs")

    logger.info(
        f"[Log Node Execution] COMPLETE {log_id} "
        f"(status: {status}, duration: {duration_ms}ms)"
    )

    try:
        if not execution_id:
            raise RuntimeError("executionId is required for workflow-data log completion")
        workflow_data_client.update_execution_log(
            str(execution_id),
            str(log_id),
            {
                "status": status,
                "output": output,
                "error": error,
                "completedAt": _iso_now(),
                "duration": str(duration_ms) if duration_ms is not None else None,
            },
        )
        logger.info(f"[Log Node Execution] Updated log via workflow-data to {status}: {log_id}")
        return {"success": True}

    except Exception as e:
        logger.error("[Log Node Execution] workflow-data log_node_complete failed: %s", e)
        return {"success": False, "error": str(e)}
