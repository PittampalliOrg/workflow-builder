"""
Persist Results to DB Activity

Writes the final workflow output to the workflow_executions table in PostgreSQL.
This is the belt-and-suspenders approach: even if the UI never polls (e.g., user
closes browser), results are saved directly by the orchestrator.

Fetches DATABASE_URL from the Dapr kubernetes-secrets store.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

import psycopg2
import requests

from core.config import config
from tracing import start_activity_span

logger = logging.getLogger(__name__)

DAPR_HOST = config.DAPR_HOST
DAPR_HTTP_PORT = config.DAPR_HTTP_PORT
SECRET_STORE_NAME = "kubernetes-secrets"
SECRET_NAME = "workflow-builder-secrets"

# Cached connection string (fetched once from Dapr secrets)
_database_url: str | None = None


def _get_database_url() -> str:
    """Fetch DATABASE_URL from the Dapr kubernetes-secrets store (cached)."""
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
        logger.info("[Persist Results] Fetched DATABASE_URL from Dapr secrets")
        return db_url

    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"Failed to fetch DATABASE_URL from Dapr secrets: {e}")


def persist_results_to_db(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Persist final workflow output to the workflow_executions table.

    Called as the last activity before the workflow returns. Skips if
    dbExecutionId is not provided (e.g., direct orchestrator API calls).

    Args:
        ctx: Dapr workflow context (required by Dapr, not used)
        input_data: Dict with keys:
            - dbExecutionId: Database execution ID (workflow_executions.id)
            - outputs: Per-node output dict {nodeId: data, ...}
            - success: Whether the workflow succeeded
            - error: Error message (if failed)
            - durationMs: Total execution duration in milliseconds

    Returns:
        Dict with success status
    """
    db_execution_id = input_data.get("dbExecutionId")
    if not db_execution_id:
        return {"success": True, "skipped": True}

    outputs = input_data.get("outputs")
    success = input_data.get("success", True)
    error = input_data.get("error")
    duration_ms = input_data.get("durationMs")
    otel = input_data.get("_otel") or {}

    logger.info(
        f"[Persist Results] Writing output to DB for execution: {db_execution_id} "
        f"(success={success}, duration={duration_ms}ms)"
    )

    attrs = {
        "db.execution_id": db_execution_id,
        "action.type": "persist_results_to_db",
    }

    with start_activity_span("activity.persist_results_to_db", otel, attrs):
        try:
            # Build the final output object (same structure as orchestrator return)
            final_output = {
                "success": success,
                "outputs": outputs,
                "durationMs": duration_ms,
                "phase": "completed" if success else "failed",
            }
            if error:
                final_output["error"] = error

            status = "success" if success else "error"

            db_url = _get_database_url()
            conn = psycopg2.connect(db_url)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE workflow_executions
                        SET output = %s,
                            status = %s,
                            completed_at = %s,
                            duration = %s
                        WHERE id = %s
                        """,
                        (
                            json.dumps(final_output),
                            status,
                            datetime.now(timezone.utc),
                            str(duration_ms) if duration_ms is not None else None,
                            db_execution_id,
                        ),
                    )
                conn.commit()
            finally:
                conn.close()

            logger.info(
                f"[Persist Results] Successfully persisted output for: {db_execution_id}"
            )
            return {"success": True}

        except Exception as e:
            logger.error(
                f"[Persist Results] Failed to persist output for {db_execution_id}: {e}"
            )
            # Don't throw - persistence failure shouldn't break workflow execution
            return {"success": False, "error": str(e)}
