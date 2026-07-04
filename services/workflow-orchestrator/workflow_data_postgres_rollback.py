"""Explicit Postgres rollback adapter for workflow-data orchestration calls.

The runtime path for orchestration persistence is workflow-data over Dapr
service invocation. This module exists only for the documented
WORKFLOW_DATA_API_MODE=postgres/http-fallback-db rollback modes and must stay
out of strict WORKFLOW_DATA_API_MODE=http execution.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any

import requests
from fastapi import HTTPException

from core.config import config

logger = logging.getLogger(__name__)

_database_url: str | None = None


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _dapr_api_token_headers() -> dict[str, str]:
    token = str(getattr(config, "DAPR_API_TOKEN", "") or "").strip()
    if not token:
        token = str(os.environ.get("DAPR_API_TOKEN") or "").strip()
    return {"dapr-api-token": token} if token else {}


def _database_secret_fetch_timeout_seconds() -> float:
    return max(
        0.0,
        _env_float("DATABASE_URL_SECRET_FETCH_TIMEOUT_SECONDS", 90.0),
    )


def _database_secret_fetch_retry_interval_seconds() -> float:
    return max(
        0.1,
        _env_float("DATABASE_URL_SECRET_FETCH_RETRY_INTERVAL_SECONDS", 1.0),
    )


def _fetch_database_url_from_dapr_secret(url: str) -> str:
    response = requests.get(
        url,
        headers=_dapr_api_token_headers(),
        timeout=10,
    )
    response.raise_for_status()
    secrets = response.json() if response.content else {}
    db_url = secrets.get("DATABASE_URL") if isinstance(secrets, dict) else None
    if not db_url:
        raise RuntimeError("DATABASE_URL not found in Dapr secrets")
    return str(db_url)


def get_database_url() -> str:
    """Resolve DATABASE_URL for rollback-mode Postgres access."""
    global _database_url
    if _database_url is not None:
        return _database_url

    env_url = os.environ.get("DATABASE_URL")
    if env_url and env_url.strip():
        _database_url = env_url.strip()
        logger.info(
            "[Workflow Data Rollback] Using DATABASE_URL from environment "
            "(preview/override)"
        )
        return _database_url

    dapr_host = config.DAPR_HOST
    dapr_port = config.DAPR_HTTP_PORT
    url = (
        f"http://{dapr_host}:{dapr_port}/v1.0/secrets/"
        "kubernetes-secrets/workflow-builder-secrets"
    )
    retry_deadline = time.monotonic() + _database_secret_fetch_timeout_seconds()
    retry_interval = _database_secret_fetch_retry_interval_seconds()
    attempts = 0
    last_error: Exception | None = None

    while True:
        attempts += 1
        try:
            db_url = _fetch_database_url_from_dapr_secret(url)
            _database_url = db_url
            logger.info(
                "[Workflow Data Rollback] Fetched DATABASE_URL from Dapr "
                "secrets after %d attempt(s)",
                attempts,
            )
            return db_url
        except Exception as e:
            last_error = e
            remaining_seconds = retry_deadline - time.monotonic()
            if remaining_seconds <= 0:
                break
            sleep_seconds = min(retry_interval, remaining_seconds)
            logger.warning(
                "[Workflow Data Rollback] DATABASE_URL secret fetch failed on "
                "attempt %d; retrying in %.1fs: %s",
                attempts,
                sleep_seconds,
                e,
            )
            time.sleep(sleep_seconds)

    raise RuntimeError(
        "Failed to fetch DATABASE_URL from Dapr secrets after "
        f"{attempts} attempt(s): {last_error}"
    ) from last_error


def assert_execution_read_model_columns() -> None:
    import psycopg2

    required_columns = {
        "current_node_id",
        "current_node_name",
        "primary_trace_id",
        "workflow_session_id",
        "summary_output",
    }

    conn = psycopg2.connect(get_database_url())
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'workflow_executions'
                  AND column_name = ANY(%s)
                """,
                (list(required_columns),),
            )
            existing = {row[0] for row in cur.fetchall()}
    finally:
        conn.close()

    missing = sorted(required_columns - existing)
    if missing:
        raise RuntimeError(
            "Execution read-model schema cutover is incomplete. "
            "Missing workflow_executions columns: "
            f"{', '.join(missing)}. Apply atlas/migrations/20260408120000_add_execution_read_model_columns.sql "
            "or drizzle/0024_execution_read_model.sql before starting workflow-orchestrator."
        )


def fetch_workflow(workflow_id: str) -> dict[str, Any]:
    import psycopg2

    conn = psycopg2.connect(get_database_url())
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, name, description, user_id, project_id, nodes, edges, spec, spec_version, dapr_workflow_name
            FROM workflows
            WHERE id = %s
            """,
            (workflow_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

        (
            wf_id,
            wf_name,
            wf_description,
            user_id,
            project_id,
            nodes_json,
            edges_json,
            spec_json,
            spec_version,
            dapr_workflow_name,
        ) = row
        nodes = json.loads(nodes_json) if isinstance(nodes_json, str) else nodes_json
        edges = json.loads(edges_json) if isinstance(edges_json, str) else edges_json
        spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json

        return {
            "id": wf_id,
            "name": wf_name,
            "description": wf_description,
            "userId": user_id,
            "projectId": project_id,
            "nodes": nodes,
            "edges": edges,
            "spec": spec,
            "specVersion": spec_version,
            "daprWorkflowName": dapr_workflow_name,
        }
    finally:
        conn.close()


def create_workflow_execution(
    execution_id: str,
    workflow_id: str,
    user_id: str,
    trigger_data: dict[str, Any],
    project_id: str | None = None,
) -> str:
    import psycopg2

    conn = psycopg2.connect(get_database_url())
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO workflow_executions (
                    id, workflow_id, user_id, project_id, status, input, phase, progress, workflow_session_id
                )
                VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s)
                """,
                (
                    execution_id,
                    workflow_id,
                    user_id,
                    project_id,
                    "running",
                    json.dumps(trigger_data or {}),
                    "running",
                    0,
                    execution_id,
                ),
            )
        conn.commit()
    finally:
        conn.close()
    return execution_id


def mark_workflow_execution_started(
    execution_id: str,
    dapr_instance_id: str,
    primary_trace_id: str | None = None,
) -> None:
    import psycopg2

    conn = psycopg2.connect(get_database_url())
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE workflow_executions
                SET dapr_instance_id = %s,
                    phase = %s,
                    progress = %s,
                    workflow_session_id = COALESCE(workflow_session_id, %s),
                    primary_trace_id = COALESCE(primary_trace_id, %s)
                WHERE id = %s
                """,
                (
                    dapr_instance_id,
                    "running",
                    0,
                    execution_id,
                    primary_trace_id,
                    execution_id,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def existing_live_execution_instance(execution_id: str) -> str | None:
    import psycopg2

    conn = psycopg2.connect(get_database_url())
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT status, dapr_instance_id
                FROM workflow_executions
                WHERE id = %s
                """,
                (execution_id,),
            )
            row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        return None

    status = str(row[0] or "").strip().lower()
    dapr_instance_id = str(row[1] or "").strip()
    if not dapr_instance_id:
        return None
    if status in {"completed", "failed", "error", "cancelled", "terminated"}:
        return None
    return dapr_instance_id


def execution_status_for_instance(instance_id: str) -> str | None:
    import psycopg2

    try:
        conn = psycopg2.connect(get_database_url(), connect_timeout=3)
    except Exception as exc:
        logger.warning(
            "[Idempotent Schedule] DB status connect failed for %s: %s",
            instance_id,
            exc,
        )
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT status FROM workflow_executions WHERE dapr_instance_id = %s LIMIT 1",
                (instance_id,),
            )
            row = cur.fetchone()
    except Exception as exc:
        logger.warning(
            "[Idempotent Schedule] DB status lookup failed for %s: %s",
            instance_id,
            exc,
        )
        return None
    finally:
        conn.close()
    return str(row[0]).strip().lower() if row and row[0] else None


def mark_execution_start_failed(execution_id: str, error: str) -> None:
    import psycopg2

    conn = psycopg2.connect(get_database_url())
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE workflow_executions
                SET status = %s,
                    phase = %s,
                    progress = %s,
                    error = %s,
                    completed_at = %s
                WHERE id = %s
                """,
                (
                    "error",
                    "failed",
                    100,
                    error,
                    datetime.now(timezone.utc),
                    execution_id,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def list_stale_running_execution_rows(
    stale_threshold_minutes: int,
) -> list[tuple[str, str | None, Any]]:
    import psycopg2

    conn = psycopg2.connect(get_database_url())
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, dapr_instance_id, input
                FROM workflow_executions
                WHERE status = 'running'
                  AND started_at < NOW() - INTERVAL '%s minutes'
                """,
                (stale_threshold_minutes,),
            )
            return list(cur.fetchall())
    finally:
        conn.close()
