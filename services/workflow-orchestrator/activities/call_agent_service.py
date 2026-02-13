"""
Call Agent Service Activities

Activities that call planner-dapr-agent to run the workflow-builder "agent" step
as a durable Dapr workflow and report completion via pub/sub → external events.
"""

from __future__ import annotations

import logging

import httpx

from core.config import config

logger = logging.getLogger(__name__)

DAPR_HOST = config.DAPR_HOST
DAPR_HTTP_PORT = config.DAPR_HTTP_PORT
PLANNER_APP_ID = config.PLANNER_APP_ID
MASTRA_AGENT_APP_ID = config.MASTRA_AGENT_APP_ID


def call_agent_run(ctx, input_data: dict) -> dict:
    """
    Start a workflow-builder agent run on planner-dapr-agent.

    Expected input_data:
      - prompt: str
      - model: str | None
      - maxTurns: int | str | None
      - allowedActionsJson: str | None (JSON array)
      - agentToolsJson: str | None (JSON array; optional structured tool list)
      - stopCondition: str | None
      - integrations: dict | None
      - dbExecutionId: str | None
      - connectionExternalId: str | None
      - parentExecutionId: str (Dapr parent workflow instance id)
      - executionId: str (logical execution id)
      - workflowId: str (workflow definition id)
      - nodeId: str (agent node id)
      - nodeName: str (agent node label)
    """
    url = (
        f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/"
        f"{PLANNER_APP_ID}/method/workflow-builder/agent/dapr"
    )

    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(url, json=input_data)
            resp.raise_for_status()
            data = resp.json()
            if not isinstance(data, dict):
                return {"success": False, "error": "Invalid response from agent service"}
            return data
    except Exception as e:
        logger.error(f"[Call Agent Run] Failed: {e}")
        return {"success": False, "error": str(e)}


def call_mastra_agent_run(ctx, input_data: dict) -> dict:
    """
    Start a Mastra agent run on mastra-agent-mcp.

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
        f"{MASTRA_AGENT_APP_ID}/method/run"
    )

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
