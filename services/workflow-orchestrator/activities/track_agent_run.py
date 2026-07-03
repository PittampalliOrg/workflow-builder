"""
Track Agent Run Activities

Persists durable child-run lifecycle records into workflow_agent_runs so
workflow-builder can render child-run/timeline/observability metadata even when
the orchestrator uses native Dapr child workflows.
"""

from __future__ import annotations

import logging
from typing import Any

from activities.workflow_data_client import workflow_data_client
from tracing import start_activity_span

logger = logging.getLogger(__name__)


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


def _extract_workspace_ref(result: Any) -> str | None:
    if not isinstance(result, dict):
        return None

    direct = str(result.get("workspaceRef") or "").strip()
    if direct:
        return direct

    all_tool_calls = result.get("all_tool_calls")
    if not isinstance(all_tool_calls, list):
        return None

    for item in reversed(all_tool_calls):
        if not isinstance(item, dict):
            continue
        execution_result = item.get("execution_result")
        if not isinstance(execution_result, dict):
            continue
        sandbox = execution_result.get("sandbox")
        if not isinstance(sandbox, dict):
            continue
        details = sandbox.get("details")
        if not isinstance(details, dict):
            continue
        workspace_ref = str(details.get("workspaceRef") or "").strip()
        if workspace_ref:
            return workspace_ref

    return None


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
            workflow_data_client.schedule_agent_run(
                {
                    "id": run_id,
                    "workflowExecutionId": workflow_execution_id,
                    "workflowId": workflow_id,
                    "nodeId": node_id,
                    "mode": mode,
                    "agentWorkflowId": agent_workflow_id,
                    "daprInstanceId": dapr_instance_id,
                    "parentExecutionId": parent_execution_id,
                    "workspaceRef": workspace_ref,
                    "artifactRef": artifact_ref,
                }
            )
            return {"success": True, "id": run_id}
        except Exception as exc:
            logger.warning(
                "[Track Agent Run] workflow-data failed to persist scheduled row %s: %s",
                run_id,
                exc,
            )
            return {"success": False, "id": run_id, "error": str(exc)}


def track_agent_run_completed(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Mark a workflow_agent_runs row as completed/failed and optionally
    note that its completion event was published.

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
    result_value = input_data.get("result")
    workspace_ref = _extract_workspace_ref(result_value)
    error = str(input_data.get("error") or "").strip() or None
    otel = input_data.get("_otel") or {}

    status = "completed" if run_success else "failed"

    attrs = {
        "action.type": "track_agent_run_completed",
        "agent.run_id": run_id,
        "agent.status": status,
    }

    with start_activity_span("activity.track_agent_run_completed", otel, attrs):
        try:
            workflow_data_client.update_agent_run(
                run_id,
                {
                    "status": status,
                    "result": result_value,
                    "error": error,
                    "workspaceRef": workspace_ref,
                    "eventPublished": mark_event_published,
                },
            )
            return {"success": True, "id": run_id, "status": status}
        except Exception as exc:
            logger.warning(
                "[Track Agent Run] workflow-data failed to persist completion row %s: %s",
                run_id,
                exc,
            )
            return {"success": False, "id": run_id, "error": str(exc)}


def track_agent_run_running(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Mark a workflow_agent_runs row as running and optionally persist the latest
    in-flight result metadata.

    Expected fields:
      - id
      - result (optional)
    """
    run_id = str(input_data.get("id") or "").strip()
    if not run_id:
        return {"success": False, "error": "id is required"}

    otel = input_data.get("_otel") or {}

    attrs = {
        "action.type": "track_agent_run_running",
        "agent.run_id": run_id,
        "agent.status": "running",
    }

    with start_activity_span("activity.track_agent_run_running", otel, attrs):
        try:
            workflow_data_client.update_agent_run(
                run_id,
                {
                    "status": "running",
                    "result": input_data.get("result"),
                },
            )
            return {"success": True, "id": run_id, "status": "running"}
        except Exception as exc:
            logger.warning(
                "[Track Agent Run] workflow-data failed to persist running row %s: %s",
                run_id,
                exc,
            )
            return {"success": False, "id": run_id, "error": str(exc)}
