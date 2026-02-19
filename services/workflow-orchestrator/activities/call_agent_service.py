"""
Call Agent Service Activities

Activities that call mastra-agent-tanstack to run agent actions
as durable Dapr workflows and report completion via pub/sub external events.
"""

from __future__ import annotations

import logging

import httpx

from core.config import config
from tracing import start_activity_span

logger = logging.getLogger(__name__)

DAPR_HOST = config.DAPR_HOST
DAPR_HTTP_PORT = config.DAPR_HTTP_PORT
MASTRA_AGENT_APP_ID = config.MASTRA_AGENT_APP_ID
DURABLE_AGENT_APP_ID = config.DURABLE_AGENT_APP_ID


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


def call_mastra_agent_run(ctx, input_data: dict) -> dict:
    """
    Start a Mastra agent run on mastra-agent-tanstack.

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
    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/"
        f"{MASTRA_AGENT_APP_ID}/method/api/run"
    )
    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "agent/mastra-run",
        "workflow.instance_id": input_data.get("parentExecutionId") or "",
        "workflow.id": input_data.get("workflowId") or "",
        "node.id": input_data.get("nodeId") or "",
        "node.name": input_data.get("nodeName") or "",
    }

    with start_activity_span("activity.call_mastra_agent_run", otel, attrs):
        try:
            with httpx.Client(timeout=30.0) as client:
                return _post_json_with_details(
                    client=client,
                    url=url,
                    payload=input_data,
                    service_label="Mastra agent run",
                )
        except Exception as e:
            logger.error(f"[Call Mastra Agent Run] Failed: {e}")
            return {"success": False, "error": str(e)}


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
    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/"
        f"{DURABLE_AGENT_APP_ID}/method/api/run"
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


def call_durable_plan(ctx, input_data: dict) -> dict:
    """
    Generate a structured plan on durable-agent service.
    """
    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/"
        f"{DURABLE_AGENT_APP_ID}/method/api/plan"
    )
    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "durable/plan",
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
                    "instructions": input_data.get("instructions"),
                    "tools": input_data.get("tools"),
                    "loopPolicy": input_data.get("loopPolicy"),
                    "agentConfig": input_data.get("agentConfig"),
                    "parentExecutionId": input_data.get("parentExecutionId", ""),
                    "executionId": input_data.get("dbExecutionId")
                    or input_data.get("executionId", ""),
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
                    "cleanupWorkspace": input_data.get("cleanupWorkspace"),
                    "loopPolicy": input_data.get("loopPolicy"),
                    "approval": input_data.get("approval"),
                    "parentExecutionId": input_data.get("parentExecutionId", ""),
                    "executionId": input_data.get("dbExecutionId")
                    or input_data.get("executionId", ""),
                    "dbExecutionId": input_data.get("dbExecutionId", ""),
                    "workflowId": input_data.get("workflowId", ""),
                    "nodeId": input_data.get("nodeId", ""),
                    "nodeName": input_data.get("nodeName", ""),
                    "workspaceRef": input_data.get("workspaceRef", ""),
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
