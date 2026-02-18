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


def _coerce_duration_ms(value: Any) -> int | None:
    """Best-effort convert duration input to a non-negative integer."""
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


SUMMARY_OUTPUT_KEYS = (
    "text",
    "toolCalls",
    "fileChanges",
    "patch",
    "patchRef",
    "changeSummary",
    "artifactRef",
    "plan",
    "planMarkdown",
    "planPolicy",
    "tasks",
    "daprInstanceId",
    "workspaceRef",
    "cleanup",
)


def _has_file_changes(candidate: dict[str, Any]) -> bool:
    """True when output shape indicates changed files."""
    file_changes = candidate.get("fileChanges")
    if isinstance(file_changes, list) and len(file_changes) > 0:
        return True

    summary = candidate.get("changeSummary")
    if not isinstance(summary, dict):
        return False

    changed = summary.get("changed")
    if isinstance(changed, bool) and changed:
        return True

    stats = summary.get("stats")
    if isinstance(stats, dict):
        files = stats.get("files")
        additions = stats.get("additions")
        deletions = stats.get("deletions")
        if isinstance(files, int) and files > 0:
            return True
        if isinstance(additions, int) and additions > 0:
            return True
        if isinstance(deletions, int) and deletions > 0:
            return True

    return False


def _extract_summary_fields_from_outputs(outputs: Any) -> dict[str, Any]:
    """
    Pull top-level summary fields (fileChanges/changeSummary/etc.) from the
    most relevant node output so workflow_executions.output is UI-friendly.
    """
    if not isinstance(outputs, dict):
        return {}

    values = [v for v in outputs.values() if isinstance(v, dict)]
    if not values:
        return {}

    # Prefer the latest output that actually includes file change data.
    source: dict[str, Any] | None = None
    for value in reversed(values):
        if _has_file_changes(value):
            source = value
            break

    # Fallback to the latest object output.
    if source is None:
        source = values[-1]

    return {
        key: source.get(key)
        for key in SUMMARY_OUTPUT_KEYS
        if source.get(key) is not None
    }


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
    duration_ms = _coerce_duration_ms(input_data.get("durationMs"))
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
            summary_fields = _extract_summary_fields_from_outputs(outputs)
            for key in SUMMARY_OUTPUT_KEYS:
                explicit = input_data.get(key)
                if explicit is not None:
                    summary_fields[key] = explicit

            # Build the final output object (same structure as orchestrator return)
            final_output = {
                "success": success,
                "outputs": outputs,
                "durationMs": duration_ms,
                "phase": "completed" if success else "failed",
            }
            final_output.update(summary_fields)
            if error:
                final_output["error"] = error

            status = "success" if success else "error"
            phase = "completed" if success else "failed"
            progress = 100
            completed_at = datetime.now(timezone.utc)

            db_url = _get_database_url()
            conn = psycopg2.connect(db_url)
            try:
                with conn.cursor() as cur:
                    # Prefer wall-clock duration based on DB started_at to avoid replay artifacts.
                    cur.execute(
                        """
                        SELECT started_at
                        FROM workflow_executions
                        WHERE id = %s
                        LIMIT 1
                        """,
                        (db_execution_id,),
                    )
                    row = cur.fetchone()
                    started_at = row[0] if row else None
                    if started_at and getattr(started_at, "tzinfo", None) is None:
                        started_at = started_at.replace(tzinfo=timezone.utc)
                    computed_duration_ms = None
                    if started_at:
                        computed_duration_ms = max(
                            int((completed_at - started_at).total_seconds() * 1000), 0
                        )
                    persisted_duration_ms = (
                        computed_duration_ms
                        if computed_duration_ms is not None
                        else duration_ms
                    )

                    cur.execute(
                        """
                        UPDATE workflow_executions
                        SET output = %s,
                            status = %s,
                            phase = %s,
                            progress = %s,
                            error = %s,
                            completed_at = %s,
                            duration = %s
                        WHERE id = %s
                        """,
                        (
                            json.dumps(final_output),
                            status,
                            phase,
                            progress,
                            None if success else error,
                            completed_at,
                            (
                                str(persisted_duration_ms)
                                if persisted_duration_ms is not None
                                else None
                            ),
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
