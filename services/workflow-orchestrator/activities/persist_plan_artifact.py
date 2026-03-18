from __future__ import annotations

import json
import logging
import uuid
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
        raise RuntimeError("DATABASE_URL not found in Dapr secrets")
    _database_url = db_url
    return db_url


def persist_plan_artifact(_ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    db_execution_id = str(input_data.get("dbExecutionId") or "").strip()
    workflow_id = str(input_data.get("workflowId") or "").strip()
    node_id = str(input_data.get("nodeId") or "").strip()
    goal = str(input_data.get("goal") or "").strip()
    source_prompt = str(input_data.get("sourcePrompt") or goal).strip()
    plan_json = input_data.get("planJson")
    plan_markdown = str(input_data.get("planMarkdown") or "").strip() or None
    artifact_type = str(input_data.get("artifactType") or "claude_task_graph_v1").strip()
    status = str(input_data.get("status") or "draft").strip() or "draft"
    workspace_ref = str(input_data.get("workspaceRef") or "").strip() or None
    clone_path = str(input_data.get("clonePath") or "").strip() or None
    metadata = input_data.get("metadata") if isinstance(input_data.get("metadata"), dict) else None
    otel = input_data.get("_otel") or {}

    if not db_execution_id or not workflow_id or not node_id or not goal or not isinstance(plan_json, dict):
        return {"success": False, "error": "Missing required plan artifact fields"}

    artifact_ref = str(input_data.get("artifactRef") or "").strip() or f"plan_{uuid.uuid4().hex[:16]}"

    with start_activity_span(
        "activity.persist_plan_artifact",
        otel,
        {
            "db.execution_id": db_execution_id,
            "workflow.id": workflow_id,
            "node.id": node_id,
            "artifact.ref": artifact_ref,
        },
    ):
        try:
            db_url = _get_database_url()
            conn = psycopg2.connect(db_url)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT user_id, workflow_id
                        FROM workflow_executions
                        WHERE id = %s
                        LIMIT 1
                        """,
                        (db_execution_id,),
                    )
                    execution_row = cur.fetchone()
                    user_id = execution_row[0] if execution_row else None
                    workflow_id_value = execution_row[1] if execution_row and execution_row[1] else workflow_id
                    cur.execute(
                        """
                        INSERT INTO workflow_plan_artifacts (
                            id,
                            workflow_execution_id,
                            workflow_id,
                            user_id,
                            node_id,
                            workspace_ref,
                            clone_path,
                            artifact_type,
                            artifact_version,
                            status,
                            goal,
                            plan_json,
                            plan_markdown,
                            source_prompt,
                            metadata
                        ) VALUES (
                            %s, %s, %s, %s, %s, %s, %s, %s, 1, %s, %s, %s, %s, %s, %s
                        )
                        ON CONFLICT (id) DO UPDATE SET
                            status = EXCLUDED.status,
                            goal = EXCLUDED.goal,
                            plan_json = EXCLUDED.plan_json,
                            plan_markdown = EXCLUDED.plan_markdown,
                            source_prompt = EXCLUDED.source_prompt,
                            metadata = EXCLUDED.metadata,
                            workspace_ref = EXCLUDED.workspace_ref,
                            clone_path = EXCLUDED.clone_path,
                            updated_at = NOW()
                        """,
                        (
                            artifact_ref,
                            db_execution_id,
                            workflow_id_value,
                            user_id,
                            node_id,
                            workspace_ref,
                            clone_path,
                            artifact_type,
                            status,
                            goal,
                            json.dumps(plan_json),
                            plan_markdown,
                            source_prompt,
                            json.dumps(metadata) if metadata is not None else None,
                        ),
                    )
                conn.commit()
            finally:
                conn.close()
            return {
                "success": True,
                "artifactRef": artifact_ref,
                "storageBackend": "workflow_plan_artifacts",
                "artifactType": artifact_type,
                "status": status,
            }
        except Exception as exc:
            logger.error("Failed to persist plan artifact %s: %s", artifact_ref, exc)
            return {"success": False, "error": str(exc)}


def update_plan_artifact_status(_ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    artifact_ref = str(input_data.get("artifactRef") or "").strip()
    status = str(input_data.get("status") or "").strip()
    metadata = input_data.get("metadata") if isinstance(input_data.get("metadata"), dict) else None
    otel = input_data.get("_otel") or {}
    if not artifact_ref or not status:
        return {"success": False, "error": "artifactRef and status are required"}

    with start_activity_span(
        "activity.update_plan_artifact_status",
        otel,
        {"artifact.ref": artifact_ref, "artifact.status": status},
    ):
        try:
            db_url = _get_database_url()
            conn = psycopg2.connect(db_url)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE workflow_plan_artifacts
                        SET status = %s,
                            metadata = COALESCE(%s::jsonb, metadata),
                            updated_at = NOW()
                        WHERE id = %s
                        """,
                        (
                            status,
                            json.dumps(metadata) if metadata is not None else None,
                            artifact_ref,
                        ),
                    )
                conn.commit()
            finally:
                conn.close()
            return {"success": True, "artifactRef": artifact_ref, "status": status}
        except Exception as exc:
            logger.error("Failed to update plan artifact %s: %s", artifact_ref, exc)
            return {"success": False, "error": str(exc)}


def fetch_plan_artifact(_ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    artifact_ref = str(input_data.get("artifactRef") or "").strip()
    otel = input_data.get("_otel") or {}
    if not artifact_ref:
        return {"success": False, "error": "artifactRef is required"}

    with start_activity_span(
        "activity.fetch_plan_artifact",
        otel,
        {"artifact.ref": artifact_ref},
    ):
        try:
            db_url = _get_database_url()
            conn = psycopg2.connect(db_url)
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT id, status, goal, plan_json, plan_markdown, metadata, workspace_ref, clone_path
                        FROM workflow_plan_artifacts
                        WHERE id = %s
                        LIMIT 1
                        """,
                        (artifact_ref,),
                    )
                    row = cur.fetchone()
            finally:
                conn.close()
            if not row:
                return {"success": False, "error": f"Plan artifact not found: {artifact_ref}"}
            return {
                "success": True,
                "artifactRef": row[0],
                "status": row[1],
                "goal": row[2],
                "planJson": row[3],
                "planMarkdown": row[4],
                "metadata": row[5],
                "workspaceRef": row[6],
                "clonePath": row[7],
            }
        except Exception as exc:
            logger.error("Failed to fetch plan artifact %s: %s", artifact_ref, exc)
            return {"success": False, "error": str(exc)}
