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
                resp = client.post(url, json=input_data)
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, dict):
                    return {"success": False, "error": "Invalid response from mastra agent service"}
                return data
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
                resp = client.post(url, json=input_data)
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, dict):
                    return {"success": False, "error": "Invalid response from durable agent service"}
                return data
        except Exception as e:
            logger.error(f"[Call Durable Agent Run] Failed: {e}")
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
        "action.type": "mastra/execute",
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
                    "cwd": input_data.get("cwd", ""),
                    "parentExecutionId": input_data.get("parentExecutionId", ""),
                    "executionId": input_data.get("executionId", ""),
                    "workflowId": input_data.get("workflowId", ""),
                    "nodeId": input_data.get("nodeId", ""),
                    "nodeName": input_data.get("nodeName", ""),
                    "workspaceRef": input_data.get("workspaceRef", ""),
                }
                if input_data.get("maxTurns"):
                    payload["maxTurns"] = input_data["maxTurns"]
                resp = client.post(url, json=payload)
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, dict):
                    return {"success": False, "error": "Invalid response"}
                return data
        except Exception as e:
            logger.error(f"[Call Mastra Execute Plan] Failed: {e}")
            return {"success": False, "error": str(e)}


def cleanup_execution_workspaces(ctx, input_data: dict) -> dict:
    """
    Cleanup any workspace session(s) associated with a workflow execution.

    Expected input_data:
      - executionId: str
    """
    execution_id = str(input_data.get("executionId") or "").strip()
    if not execution_id:
        return {"success": False, "error": "executionId is required"}

    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/"
        f"{DURABLE_AGENT_APP_ID}/method/api/workspaces/cleanup"
    )
    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "workspace/cleanup",
        "workflow.instance_id": execution_id,
    }

    with start_activity_span("activity.cleanup_execution_workspaces", otel, attrs):
        try:
            with httpx.Client(timeout=15.0) as client:
                resp = client.post(url, json={"executionId": execution_id})
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, dict):
                    return {"success": False, "error": "Invalid response from durable agent service"}
                return data
        except Exception as e:
            logger.error(f"[Cleanup Workspaces] Failed: {e}")
            return {"success": False, "error": str(e)}
