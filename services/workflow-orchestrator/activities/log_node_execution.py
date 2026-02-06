"""
Log Node Execution Activity

Writes execution logs for planner/* nodes directly to the workflow_execution_logs
table in PostgreSQL. Regular action nodes are already logged by function-router;
this activity fills the gap for planner nodes that bypass function-router.

Fetches DATABASE_URL from the Dapr kubernetes-secrets store (reading from the
workflow-builder-secrets K8s secret).
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

import psycopg2
import requests

from core.config import config

logger = logging.getLogger(__name__)

DAPR_HOST = config.DAPR_HOST
DAPR_HTTP_PORT = config.DAPR_HTTP_PORT
SECRET_STORE_NAME = "kubernetes-secrets"
SECRET_NAME = "workflow-builder-secrets"

# Cached connection string (fetched once from Dapr secrets)
_database_url: str | None = None


def _get_database_url() -> str:
    """
    Fetch DATABASE_URL from the Dapr kubernetes-secrets store.

    The secret is stored in the K8s secret 'workflow-builder-secrets' under the
    key 'DATABASE_URL'. Caches the result after first fetch.

    Returns:
        PostgreSQL connection string

    Raises:
        RuntimeError: If the secret cannot be fetched
    """
    global _database_url
    if _database_url is not None:
        return _database_url

    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}"
        f"/v1.0/secrets/{SECRET_STORE_NAME}/{SECRET_NAME}"
    )

    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        secrets = response.json()

        db_url = secrets.get("DATABASE_URL")
        if not db_url:
            raise RuntimeError(
                f"DATABASE_URL not found in secret '{SECRET_NAME}' "
                f"from store '{SECRET_STORE_NAME}'"
            )

        _database_url = db_url
        logger.info("[Log Node Execution] Fetched DATABASE_URL from Dapr secrets")
        return db_url

    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"Failed to fetch DATABASE_URL from Dapr secrets: {e}")


def _json_dumps_safe(value: Any) -> str | None:
    """Safely serialize a value to JSON string, returning None if empty/None."""
    if value is None:
        return None
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return json.dumps(str(value))


def log_node_start(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Insert a 'running' row into workflow_execution_logs.

    Called before a planner/* node begins execution.

    Args:
        ctx: Dapr workflow context (required by Dapr, not used)
        input_data: Dict with keys:
            - executionId: DB execution ID (workflow_executions.id)
            - nodeId: Node ID in the workflow
            - nodeName: Display name of the node
            - nodeType: Node type (e.g., "action")
            - actionType: Function slug (e.g., "planner/plan")
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
        db_url = _get_database_url()
        conn = psycopg2.connect(db_url)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO workflow_execution_logs
                        (id, execution_id, node_id, node_name, node_type,
                         activity_name, status, input, started_at, timestamp)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        log_id,
                        execution_id,
                        node_id,
                        node_name,
                        node_type,
                        action_type,
                        "running",
                        _json_dumps_safe(node_input),
                        datetime.now(timezone.utc),
                        datetime.now(timezone.utc),
                    ),
                )
            conn.commit()
        finally:
            conn.close()

        logger.info(f"[Log Node Execution] Inserted running log: {log_id}")
        return {"success": True, "logId": log_id}

    except Exception as e:
        logger.error(f"[Log Node Execution] Failed to log node start: {e}")
        # Don't throw - logging failure shouldn't break workflow execution
        return {"success": False, "logId": log_id, "error": str(e)}


def log_node_complete(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Update the execution log row with completion status, output, and duration.

    Called after a planner/* node finishes (success or error).

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
        db_url = _get_database_url()
        conn = psycopg2.connect(db_url)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE workflow_execution_logs
                    SET status = %s,
                        output = %s,
                        error = %s,
                        completed_at = %s,
                        duration = %s
                    WHERE id = %s
                    """,
                    (
                        status,
                        _json_dumps_safe(output),
                        error,
                        datetime.now(timezone.utc),
                        str(duration_ms) if duration_ms is not None else None,
                        log_id,
                    ),
                )
            conn.commit()
        finally:
            conn.close()

        logger.info(f"[Log Node Execution] Updated log to {status}: {log_id}")
        return {"success": True}

    except Exception as e:
        logger.error(f"[Log Node Execution] Failed to log node complete: {e}")
        # Don't throw - logging failure shouldn't break workflow execution
        return {"success": False, "error": str(e)}
