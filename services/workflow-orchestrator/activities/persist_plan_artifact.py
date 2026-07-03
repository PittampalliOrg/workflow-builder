from __future__ import annotations

import logging
import uuid
from typing import Any

from activities.workflow_data_client import workflow_data_client
from tracing import start_activity_span

logger = logging.getLogger(__name__)


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
            result = workflow_data_client.upsert_plan_artifact(
                {
                    "artifactRef": artifact_ref,
                    "workflowExecutionId": db_execution_id,
                    "workflowId": workflow_id,
                    "nodeId": node_id,
                    "goal": goal,
                    "planJson": plan_json,
                    "planMarkdown": plan_markdown,
                    "sourcePrompt": source_prompt,
                    "artifactType": artifact_type,
                    "status": status,
                    "workspaceRef": workspace_ref,
                    "clonePath": clone_path,
                    "metadata": metadata,
                }
            )
            return {
                "success": True,
                "artifactRef": result.get("artifactRef", artifact_ref),
                "storageBackend": result.get(
                    "storageBackend",
                    "workflow_plan_artifacts",
                ),
                "artifactType": result.get("artifactType", artifact_type),
                "status": result.get("status", status),
            }
        except Exception as exc:
            logger.error("workflow-data failed to persist plan artifact %s: %s", artifact_ref, exc)
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
            result = workflow_data_client.update_plan_artifact(
                artifact_ref,
                {
                    "status": status,
                    "metadata": metadata,
                },
            )
            return {
                "success": True,
                "artifactRef": result.get("artifactRef", artifact_ref),
                "status": result.get("status", status),
            }
        except Exception as exc:
            logger.error("workflow-data failed to update plan artifact %s: %s", artifact_ref, exc)
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
            artifact = workflow_data_client.get_plan_artifact(artifact_ref)
            if not artifact:
                return {"success": False, "error": f"Plan artifact not found: {artifact_ref}"}
            return {
                "success": True,
                "artifactRef": artifact.get("artifactRef", artifact_ref),
                "status": artifact.get("status"),
                "goal": artifact.get("goal"),
                "planJson": artifact.get("planJson"),
                "planMarkdown": artifact.get("planMarkdown"),
                "metadata": artifact.get("metadata"),
                "workspaceRef": artifact.get("workspaceRef"),
                "clonePath": artifact.get("clonePath"),
            }
        except Exception as exc:
            logger.error("workflow-data failed to fetch plan artifact %s: %s", artifact_ref, exc)
            return {"success": False, "error": str(exc)}
