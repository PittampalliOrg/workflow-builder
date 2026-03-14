"""
Call Agent Service Activities

Activities that call durable-agent to run agent actions
as durable Dapr workflows and report completion via pub/sub external events.
"""

from __future__ import annotations

import logging
from urllib.parse import quote

import httpx

from core.config import config
from tracing import start_activity_span

logger = logging.getLogger(__name__)

DAPR_HOST = config.DAPR_HOST
DAPR_HTTP_PORT = config.DAPR_HTTP_PORT
DURABLE_AGENT_APP_ID = config.DURABLE_AGENT_APP_ID
MS_AGENT_APP_ID = config.MS_AGENT_APP_ID


def _post_json_with_details(
    *,
    client: httpx.Client,
    url: str,
    payload: dict,
    service_label: str,
) -> dict:
    response = client.post(url, json=payload)
    if response.status_code >= 400:
        body = (response.text or "").strip()
        body_preview = body[:1200] if body else "<empty>"
        raise RuntimeError(
            f"{service_label} failed with HTTP {response.status_code}: {body_preview}"
        )

    try:
        data = response.json()
    except ValueError as exc:
        body_preview = (response.text or "").strip()[:1200]
        raise RuntimeError(
            f"{service_label} returned non-JSON response: {body_preview}"
        ) from exc

    if not isinstance(data, dict):
        raise RuntimeError(
            f"{service_label} returned invalid response type: {type(data).__name__}"
        )

    return data


def _as_bool(value: object, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized == "true":
            return True
        if normalized == "false":
            return False
    return default


def terminate_durable_runs_by_parent_execution(
    parent_execution_id: str,
    reason: str | None = None,
    cleanup_workspace: bool = True,
) -> dict:
    """
    Terminate active durable-agent runs belonging to a parent workflow execution.
    """
    parent_execution_id = str(parent_execution_id or "").strip()
    if not parent_execution_id:
        return {"success": False, "error": "parentExecutionId is required"}

    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/"
        f"{DURABLE_AGENT_APP_ID}/method/api/runs/terminate-by-parent"
    )
    payload = {
        "parentExecutionId": parent_execution_id,
        "reason": reason or "terminated due to parent workflow termination",
        "cleanupWorkspace": cleanup_workspace,
    }
    with httpx.Client(timeout=20.0) as client:
        return _post_json_with_details(
            client=client,
            url=url,
            payload=payload,
            service_label="Durable run parent termination",
        )


def call_durable_agent_run(ctx, input_data: dict) -> dict:
    """
    Start a durable agent run on durable-agent service.

    Expected input_data:
      - prompt: str
      - parentExecutionId: str (Dapr parent workflow instance id)
      - executionId: str (logical execution id)
      - workflowId: str (workflow definition id)
      - nodeId: str (agent node id)
      - nodeName: str (agent node label)
      - model: str | None
      - maxTurns: int | None
    """
    workspace_ref = str(input_data.get("workspaceRef") or "").strip()
    run_route = "api/run-sandboxed" if workspace_ref else "api/run"
    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/"
        f"{DURABLE_AGENT_APP_ID}/method/{run_route}"
    )
    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "durable/run",
        "workflow.instance_id": input_data.get("parentExecutionId") or "",
        "workflow.id": input_data.get("workflowId") or "",
        "node.id": input_data.get("nodeId") or "",
        "node.name": input_data.get("nodeName") or "",
    }

    with start_activity_span("activity.call_durable_agent_run", otel, attrs):
        try:
            with httpx.Client(timeout=30.0) as client:
                return _post_json_with_details(
                    client=client,
                    url=url,
                    payload=input_data,
                    service_label="Durable agent run",
                )
        except Exception as e:
            logger.error(f"[Call Durable Agent Run] Failed: {e}")
            return {"success": False, "error": str(e)}


def terminate_ms_agent_run(ctx, input_data: dict) -> dict:
    """
    Terminate a Microsoft Agent child workflow run.
    """
    agent_workflow_id = str(
        input_data.get("agentWorkflowId") or input_data.get("daprInstanceId") or ""
    ).strip()
    if not agent_workflow_id:
        return {"success": False, "error": "agentWorkflowId is required"}

    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/"
        f"{MS_AGENT_APP_ID}/method/api/run/{quote(agent_workflow_id, safe='')}/terminate"
    )
    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "ms-agent/run-terminate",
        "agent.workflow_id": agent_workflow_id,
        "workflow.instance_id": input_data.get("parentExecutionId") or "",
    }

    with start_activity_span("activity.terminate_ms_agent_run", otel, attrs):
        try:
            with httpx.Client(timeout=20.0) as client:
                return _post_json_with_details(
                    client=client,
                    url=url,
                    payload={
                        "reason": input_data.get("reason")
                        or "terminated by workflow-orchestrator",
                    },
                    service_label="MS agent run termination",
                )
        except Exception as e:
            logger.error(f"[Terminate MS Agent Run] Failed: {e}")
            return {"success": False, "error": str(e)}


def call_durable_plan(ctx, input_data: dict) -> dict:
    """
    Generate a structured plan on durable-agent service.
    """
    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/"
        f"{DURABLE_AGENT_APP_ID}/method/api/plan"
    )
    otel = input_data.get("_otel") or {}
    planning_backend = str(input_data.get("planningBackend") or "").strip().lower()
    action_type = "durable/claude-plan" if planning_backend == "claude_code_v1" else "durable/plan"
    attrs = {
        "action.type": action_type,
        "workflow.instance_id": input_data.get("parentExecutionId") or "",
        "workflow.id": input_data.get("workflowId") or "",
        "node.id": input_data.get("nodeId") or "",
        "node.name": input_data.get("nodeName") or "",
    }

    with start_activity_span("activity.call_durable_plan", otel, attrs):
        try:
            timeout_minutes_raw = input_data.get("timeoutMinutes", 10)
            try:
                timeout_minutes = int(timeout_minutes_raw or 10)
            except (TypeError, ValueError):
                timeout_minutes = 10
            if timeout_minutes <= 0:
                timeout_minutes = 10
            # Planning is synchronous and can run multiple turns; keep the activity
            # timeout aligned with configured planning budget plus a small buffer.
            planning_timeout_seconds = min(max(timeout_minutes * 60 + 30, 90), 3600)

            with httpx.Client(timeout=planning_timeout_seconds) as client:
                payload = {
                    "prompt": input_data.get("prompt", ""),
                    "cwd": input_data.get("cwd", ""),
                    "workspaceRef": input_data.get("workspaceRef", ""),
                    "model": input_data.get("model"),
                    "maxTurns": input_data.get("maxTurns"),
                    "timeoutMinutes": timeout_minutes,
                    "planningBackend": input_data.get("planningBackend"),
                    "instructions": input_data.get("instructions"),
                    "tools": input_data.get("tools"),
                    "loopPolicy": input_data.get("loopPolicy"),
                    "contextPolicyPreset": input_data.get("contextPolicyPreset"),
                    "agentConfig": input_data.get("agentConfig"),
                    "parentExecutionId": input_data.get("parentExecutionId", ""),
                    "executionId": input_data.get("executionId", "")
                    or input_data.get("dbExecutionId", ""),
                    "dbExecutionId": input_data.get("dbExecutionId", ""),
                    "workflowId": input_data.get("workflowId", ""),
                    "nodeId": input_data.get("nodeId", ""),
                    "nodeName": input_data.get("nodeName", ""),
                }
                return _post_json_with_details(
                    client=client,
                    url=url,
                    payload=payload,
                    service_label="Durable plan",
                )
        except Exception as e:
            logger.error(f"[Call Durable Plan] Failed: {e}")
            return {"success": False, "error": str(e)}


def call_durable_execute_plan(ctx, input_data: dict) -> dict:
    """
    Start a plan execution on durable-agent service.

    Expected input_data:
      - prompt: str
      - planJson: dict | str (the plan object with steps)
      - cwd: str (working directory)
      - parentExecutionId: str (Dapr parent workflow instance id)
      - workflowId: str (workflow definition id)
      - nodeId: str (agent node id)
      - nodeName: str (agent node label)
    """
    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/"
        f"{DURABLE_AGENT_APP_ID}/method/api/execute-plan"
    )
    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "durable/execute-plan",
        "workflow.instance_id": input_data.get("parentExecutionId") or "",
        "workflow.id": input_data.get("workflowId") or "",
        "node.id": input_data.get("nodeId") or "",
        "node.name": input_data.get("nodeName") or "",
    }

    plan = input_data.get("planJson") or input_data.get("plan")
    if isinstance(plan, str):
        import json as _json
        try:
            plan = _json.loads(plan)
        except Exception:
            pass

    with start_activity_span("activity.call_durable_execute_plan", otel, attrs):
        try:
            with httpx.Client(timeout=30.0) as client:
                payload = {
                    "prompt": input_data.get("prompt", ""),
                    "plan": plan,
                    "artifactRef": input_data.get("artifactRef", ""),
                    "cwd": input_data.get("cwd", ""),
                    "model": input_data.get("model"),
                    "instructions": input_data.get("instructions"),
                    "tools": input_data.get("tools"),
                    "agentConfig": input_data.get("agentConfig"),
                    "cleanupWorkspace": input_data.get("cleanupWorkspace"),
                    "requireFileChanges": input_data.get("requireFileChanges"),
                    "loopPolicy": input_data.get("loopPolicy"),
                    "contextPolicyPreset": input_data.get("contextPolicyPreset"),
                    "approval": input_data.get("approval"),
                    "parentExecutionId": input_data.get("parentExecutionId", ""),
                    "executionId": input_data.get("executionId", "")
                    or input_data.get("dbExecutionId", ""),
                    "dbExecutionId": input_data.get("dbExecutionId", ""),
                    "workflowId": input_data.get("workflowId", ""),
                    "nodeId": input_data.get("nodeId", ""),
                    "nodeName": input_data.get("nodeName", ""),
                    "workspaceRef": input_data.get("workspaceRef", ""),
                    "timeoutMinutes": input_data.get("timeoutMinutes"),
                }
                if input_data.get("maxTurns"):
                    payload["maxTurns"] = input_data["maxTurns"]
                return _post_json_with_details(
                    client=client,
                    url=url,
                    payload=payload,
                    service_label="Durable execute plan",
                )
        except Exception as e:
            logger.error(f"[Call Durable Execute Plan] Failed: {e}")
            return {"success": False, "error": str(e)}


def call_durable_execute_plan_dag(ctx, input_data: dict) -> dict:
    """
    Start a DAG plan execution on durable-agent service.

    Executes a claude_task_graph_v1 plan as a Dapr workflow where each task
    is a separate Claude Code CLI activity with dependency scheduling.

    Expected input_data:
      - artifactRef: str (plan artifact reference)
      - workspaceRef: str (workspace session reference)
      - cwd: str (working directory)
      - model: str | None
      - maxTaskRetries: int | None (default: 1)
      - taskTimeoutMinutes: int | None (default: 15)
      - overallTimeoutMinutes: int | None (default: 120)
      - cleanupWorkspace: bool | None (default: True)
      - parentExecutionId: str
      - executionId: str
      - workflowId: str
      - nodeId: str
      - nodeName: str
    """
    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/"
        f"{DURABLE_AGENT_APP_ID}/method/api/execute-plan-dag"
    )
    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "durable/execute-plan-dag",
        "workflow.instance_id": input_data.get("parentExecutionId") or "",
        "workflow.id": input_data.get("workflowId") or "",
        "node.id": input_data.get("nodeId") or "",
        "node.name": input_data.get("nodeName") or "",
    }

    plan = input_data.get("planJson") or input_data.get("plan")
    if isinstance(plan, str):
        import json as _json
        try:
            plan = _json.loads(plan)
        except Exception:
            pass

    with start_activity_span("activity.call_durable_execute_plan_dag", otel, attrs):
        try:
            with httpx.Client(timeout=30.0) as client:
                payload = {
                    "plan": plan,
                    "artifactRef": input_data.get("artifactRef", ""),
                    "cwd": input_data.get("cwd", ""),
                    "model": input_data.get("model"),
                    "maxTaskRetries": input_data.get("maxTaskRetries"),
                    "taskTimeoutMinutes": input_data.get("taskTimeoutMinutes"),
                    "overallTimeoutMinutes": input_data.get("overallTimeoutMinutes"),
                    "cleanupWorkspace": input_data.get("cleanupWorkspace"),
                    "parentExecutionId": input_data.get("parentExecutionId", ""),
                    "executionId": input_data.get("executionId", "")
                    or input_data.get("dbExecutionId", ""),
                    "dbExecutionId": input_data.get("dbExecutionId", ""),
                    "workflowId": input_data.get("workflowId", ""),
                    "nodeId": input_data.get("nodeId", ""),
                    "nodeName": input_data.get("nodeName", ""),
                    "workspaceRef": input_data.get("workspaceRef", ""),
                }
                return _post_json_with_details(
                    client=client,
                    url=url,
                    payload=payload,
                    service_label="Durable execute plan DAG",
                )
        except Exception as e:
            logger.error(f"[Call Durable Execute Plan DAG] Failed: {e}")
            return {"success": False, "error": str(e)}


def terminate_durable_agent_run(ctx, input_data: dict) -> dict:
    """
    Terminate a specific durable-agent run.

    Expected input_data:
      - agentWorkflowId: str
      - daprInstanceId: str | None
      - parentExecutionId: str | None
      - reason: str | None
      - cleanupWorkspace: bool | str | None
    """
    agent_workflow_id = str(input_data.get("agentWorkflowId") or "").strip()
    if not agent_workflow_id:
        return {"success": False, "error": "agentWorkflowId is required"}

    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/"
        f"{DURABLE_AGENT_APP_ID}/method/api/run/{quote(agent_workflow_id)}/terminate"
    )
    payload = {
        "daprInstanceId": input_data.get("daprInstanceId"),
        "parentExecutionId": input_data.get("parentExecutionId"),
        "workspaceRef": input_data.get("workspaceRef"),
        "reason": input_data.get("reason")
        or "terminated because parent workflow timed out",
        "cleanupWorkspace": _as_bool(input_data.get("cleanupWorkspace"), True),
    }
    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "durable/run-terminate",
        "workflow.instance_id": input_data.get("parentExecutionId") or "",
        "agent.workflow_id": agent_workflow_id,
        "agent.dapr_instance_id": input_data.get("daprInstanceId") or "",
    }

    with start_activity_span("activity.terminate_durable_agent_run", otel, attrs):
        try:
            with httpx.Client(timeout=20.0) as client:
                return _post_json_with_details(
                    client=client,
                    url=url,
                    payload=payload,
                    service_label="Durable run termination",
                )
        except Exception as e:
            logger.error(f"[Terminate Durable Agent Run] Failed: {e}")
            return {"success": False, "error": str(e)}


def cleanup_execution_workspaces(ctx, input_data: dict) -> dict:
    """
    Cleanup any workspace session(s) associated with a workflow execution.

    Expected input_data:
      - executionId: str
      - dbExecutionId: str | None
    """
    execution_id = str(input_data.get("executionId") or "").strip()
    db_execution_id = str(input_data.get("dbExecutionId") or "").strip()
    if not execution_id and not db_execution_id:
        return {
            "success": False,
            "error": "executionId or dbExecutionId is required",
        }

    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/"
        f"{DURABLE_AGENT_APP_ID}/method/api/workspaces/cleanup"
    )
    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "workspace/cleanup",
        "workflow.instance_id": execution_id,
        "workflow.db_execution_id": db_execution_id,
    }

    with start_activity_span("activity.cleanup_execution_workspaces", otel, attrs):
        try:
            with httpx.Client(timeout=15.0) as client:
                payload = {
                    "executionId": execution_id,
                    "dbExecutionId": db_execution_id,
                }
                return _post_json_with_details(
                    client=client,
                    url=url,
                    payload=payload,
                    service_label="Workspace cleanup",
                )
        except Exception as e:
            logger.error(f"[Cleanup Workspaces] Failed: {e}")
            return {"success": False, "error": str(e)}
