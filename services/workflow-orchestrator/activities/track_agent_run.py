"""
Track Agent Run Activities

Persists durable child-run lifecycle records into workflow_agent_runs so
workflow-builder can render child-run/timeline/observability metadata even when
the orchestrator uses native Dapr child workflows.
"""

from __future__ import annotations

import json
import logging
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

_database_url: str | None = None


def _get_database_url() -> str:
    """Fetch DATABASE_URL from Dapr secrets store (cached)."""
    global _database_url
    if _database_url is not None:
        return _database_url

    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}"
        f"/v1.0/secrets/{SECRET_STORE_NAME}/{SECRET_NAME}"
    )
    response = requests.get(url, timeout=10)
    response.raise_for_status()
    secrets = response.json()

    db_url = secrets.get("DATABASE_URL")
    if not db_url:
        raise RuntimeError(
            f"DATABASE_URL not found in secret '{SECRET_NAME}' from store '{SECRET_STORE_NAME}'"
        )
    _database_url = db_url
    return db_url


def _json_dumps_safe(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return json.dumps(str(value))


def _normalize_mode(value: Any) -> str:
    mode = str(value or "run").strip().lower()
    if mode in ("run", "plan", "execute_plan"):
        return mode
    return "run"


def _to_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized == "true":
            return True
        if normalized == "false":
            return False
    return default


def track_agent_run_scheduled(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Insert/update a scheduled workflow_agent_runs row.

    Expected fields:
      - id
      - workflowExecutionId
      - workflowId
      - nodeId
      - mode
      - agentWorkflowId
      - daprInstanceId
      - parentExecutionId
      - workspaceRef (optional)
      - artifactRef (optional)
    """
    run_id = str(input_data.get("id") or "").strip()
    workflow_execution_id = str(input_data.get("workflowExecutionId") or "").strip()
    workflow_id = str(input_data.get("workflowId") or "").strip()
    node_id = str(input_data.get("nodeId") or "").strip()
    mode = _normalize_mode(input_data.get("mode"))
    agent_workflow_id = str(input_data.get("agentWorkflowId") or "").strip()
    dapr_instance_id = str(input_data.get("daprInstanceId") or "").strip()
    parent_execution_id = str(input_data.get("parentExecutionId") or "").strip()
    workspace_ref = str(input_data.get("workspaceRef") or "").strip() or None
    artifact_ref = str(input_data.get("artifactRef") or "").strip() or None
    otel = input_data.get("_otel") or {}

    if not all(
        [
            run_id,
            workflow_execution_id,
            workflow_id,
            node_id,
            agent_workflow_id,
            dapr_instance_id,
            parent_execution_id,
        ]
    ):
        return {
            "success": False,
            "error": "Missing required workflow_agent_runs scheduled fields",
        }

    attrs = {
        "action.type": "track_agent_run_scheduled",
        "workflow.db_execution_id": workflow_execution_id,
        "workflow.id": workflow_id,
        "node.id": node_id,
        "agent.workflow_id": agent_workflow_id,
        "agent.dapr_instance_id": dapr_instance_id,
    }

    with start_activity_span("activity.track_agent_run_scheduled", otel, attrs):
        try:
            db_url = _get_database_url()
            conn = psycopg2.connect(db_url)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO workflow_agent_runs (
                            id,
                            workflow_execution_id,
                            workflow_id,
                            node_id,
                            mode,
                            agent_workflow_id,
                            dapr_instance_id,
                            parent_execution_id,
                            workspace_ref,
                            artifact_ref,
                            status,
                            created_at,
                            updated_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'scheduled', now(), now())
                        ON CONFLICT (id) DO UPDATE
                        SET
                            workflow_execution_id = EXCLUDED.workflow_execution_id,
                            workflow_id = EXCLUDED.workflow_id,
                            node_id = EXCLUDED.node_id,
                            mode = EXCLUDED.mode,
                            agent_workflow_id = EXCLUDED.agent_workflow_id,
                            dapr_instance_id = EXCLUDED.dapr_instance_id,
                            parent_execution_id = EXCLUDED.parent_execution_id,
                            workspace_ref = EXCLUDED.workspace_ref,
                            artifact_ref = EXCLUDED.artifact_ref,
                            status = 'scheduled',
                            updated_at = now()
                        """,
                        (
                            run_id,
                            workflow_execution_id,
                            workflow_id,
                            node_id,
                            mode,
                            agent_workflow_id,
                            dapr_instance_id,
                            parent_execution_id,
                            workspace_ref,
                            artifact_ref,
                        ),
                    )
                conn.commit()
            finally:
                conn.close()

            return {"success": True, "id": run_id}
        except Exception as exc:
            logger.warning(
                "[Track Agent Run] Failed to persist scheduled row %s: %s",
                run_id,
                exc,
            )
            return {"success": False, "id": run_id, "error": str(exc)}


def track_agent_run_completed(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Mark a workflow_agent_runs row as completed/failed/event_published.

    Expected fields:
      - id
      - success (bool)
      - result (optional)
      - error (optional)
      - eventPublished (optional bool)
    """
    run_id = str(input_data.get("id") or "").strip()
    if not run_id:
        return {"success": False, "error": "id is required"}

    run_success = _to_bool(input_data.get("success"), True)
    mark_event_published = _to_bool(input_data.get("eventPublished"), False)
    result_json = _json_dumps_safe(input_data.get("result"))
    error = str(input_data.get("error") or "").strip() or None
    otel = input_data.get("_otel") or {}

    status = "event_published" if mark_event_published else ("completed" if run_success else "failed")

    attrs = {
        "action.type": "track_agent_run_completed",
        "agent.run_id": run_id,
        "agent.status": status,
    }

    with start_activity_span("activity.track_agent_run_completed", otel, attrs):
        try:
            db_url = _get_database_url()
            conn = psycopg2.connect(db_url)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE workflow_agent_runs
                        SET
                            status = %s,
                            result = %s::jsonb,
                            error = %s,
                            completed_at = now(),
                            event_published_at = CASE
                                WHEN %s THEN now()
                                ELSE event_published_at
                            END,
                            updated_at = now()
                        WHERE id = %s
                        """,
                        (
                            status,
                            result_json,
                            error,
                            mark_event_published,
                            run_id,
                        ),
                    )
                conn.commit()
            finally:
                conn.close()

            return {"success": True, "id": run_id, "status": status}
        except Exception as exc:
            logger.warning(
                "[Track Agent Run] Failed to persist completion row %s: %s",
                run_id,
                exc,
            )
            return {"success": False, "id": run_id, "error": str(exc)}
