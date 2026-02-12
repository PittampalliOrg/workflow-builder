"""Workflow Builder Agent - durable agent step for workflow-builder.

This module adds a simple "agent primitive" that can be used as a workflow node:
  actionType: agent/run

Execution model:
- workflow-orchestrator starts this Dapr workflow via planner-dapr-agent
- the workflow runs a tool-calling agent and publishes an `agent_completed` event
- workflow-orchestrator receives the pub/sub event and raises an external event
  to unblock the parent workflow.
"""

from __future__ import annotations

import json
import logging
import os
import asyncio
import re
import uuid
from typing import Any, Dict, List, Optional

import dapr.ext.workflow as wf
import httpx
from pydantic import BaseModel, Field, ConfigDict

from dapr_multi_step_workflow import wfr, publish_workflow_event, run_agent_streamed

logger = logging.getLogger(__name__)

FUNCTION_ROUTER_APP_ID = os.getenv("FUNCTION_ROUTER_APP_ID", "function-router")
CONNECTION_TEMPLATE_PATTERN = re.compile(r"\{\{connections\[['\"]([^'\"]+)['\"]\]\}\}")


class WorkflowBuilderAgentInput(BaseModel):
    model_config = ConfigDict(extra="ignore")

    prompt: str
    model: str = "gpt-5.2-codex"
    max_turns: int = 20
    allowed_actions: List[str] = Field(default_factory=list)
    agent_tools: List[Dict[str, Any]] = Field(default_factory=list)
    stop_condition: str = ""

    # Execution context for tool routing / audit logs
    parent_execution_id: Optional[str] = None
    execution_id: Optional[str] = None
    workflow_id: Optional[str] = None
    node_id: Optional[str] = None
    node_name: Optional[str] = None
    integrations: Optional[dict] = None
    db_execution_id: Optional[str] = None
    connection_external_id: Optional[str] = None
    agent_workflow_id: Optional[str] = None


class WorkflowBuilderAgentFinal(BaseModel):
    """Structured output from the agent."""

    summary: str
    # Keep this as a JSON string because the OpenAI Agents SDK can enforce strict
    # JSON schema for outputs, and unconstrained dict/object fields introduce
    # additionalProperties which may be rejected in strict mode.
    result_json: str = "{}"


def _parse_allowed_actions_json(raw: Any) -> List[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(x) for x in raw if isinstance(x, (str, int, float))]
    if not isinstance(raw, str):
        return []

    s = raw.strip()
    if not s:
        return []

    try:
        parsed = json.loads(s)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(x) for x in parsed if isinstance(x, (str, int, float))]

def _parse_agent_tools_json(raw: Any) -> List[Dict[str, Any]]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, dict)]
    if not isinstance(raw, str):
        return []

    s = raw.strip()
    if not s:
        return []

    try:
        parsed = json.loads(s)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [x for x in parsed if isinstance(x, dict)]


def _extract_allowed_actions_from_agent_tools(tools: List[Dict[str, Any]]) -> List[str]:
    allowed: List[str] = []
    for tool in tools:
        # Preferred workflow-builder schema: {"type":"ACTION","actionType":"system/http-request"}
        action_type = tool.get("actionType")
        if isinstance(action_type, str) and action_type.strip():
            allowed.append(action_type.strip())
            continue

        # Back-compat / other shapes we might see: {"function_slug":"..."}
        function_slug = tool.get("function_slug")
        if isinstance(function_slug, str) and function_slug.strip():
            allowed.append(function_slug.strip())
            continue

    # Stable ordering
    seen = set()
    deduped: List[str] = []
    for item in allowed:
        if item in seen:
            continue
        seen.add(item)
        deduped.append(item)
    return deduped

def _extract_connection_external_id(raw: Any) -> Optional[str]:
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    if not value:
        return None

    match = CONNECTION_TEMPLATE_PATTERN.search(value)
    if match:
        return match.group(1)

    # Back-compat: allow passing externalId directly.
    if "{{" not in value and "}}" not in value:
        return value

    return None

def _extract_action_connection_map_from_agent_tools(
    tools: List[Dict[str, Any]],
) -> Dict[str, str]:
    """
    Build a map of actionType -> connectionExternalId from agent tool definitions.

    Expected shape (Activepieces-inspired):
      {
        "type": "ACTION",
        "actionType": "microsoft-onedrive/list_files",
        "predefinedInput": { "auth": "{{connections['external-id']}}" }
      }
    """
    mapping: Dict[str, str] = {}

    for tool in tools:
        action_type_raw = tool.get("actionType") or tool.get("function_slug")
        action_type = (
            action_type_raw.strip()
            if isinstance(action_type_raw, str)
            else ""
        )
        if not action_type:
            continue

        predefined_input = tool.get("predefinedInput")
        if not isinstance(predefined_input, dict):
            continue

        connection_external_id = _extract_connection_external_id(
            predefined_input.get("auth")
        )
        if connection_external_id and action_type not in mapping:
            mapping[action_type] = connection_external_id

    return mapping


@wfr.activity(name="workflow_builder_agent_run")
def workflow_builder_agent_run_activity(
    ctx: wf.WorkflowActivityContext, input_data: Dict[str, Any]
) -> Dict[str, Any]:
    """Run a tool-calling agent and return a standardized step result."""

    try:
        # Import inside activity to keep module import side-effects localized.
        from agents import Agent, function_tool

        agent_input = WorkflowBuilderAgentInput(**input_data)

        # Prefer structured tool definitions when provided; fall back to allowlist JSON.
        agent_tools = agent_input.agent_tools or []
        if not agent_tools:
            agent_tools = _parse_agent_tools_json(
                input_data.get("agent_tools_json")
                or input_data.get("agentToolsJson")
            )

        allowed_actions = agent_input.allowed_actions or []
        if not allowed_actions and agent_tools:
            allowed_actions = _extract_allowed_actions_from_agent_tools(agent_tools)
        action_connection_map = _extract_action_connection_map_from_agent_tools(agent_tools)

        # Normalize and protect: if no allowed actions provided, allow safe built-ins.
        if not allowed_actions:
            allowed_actions = [
                "system/http-request",
                "system/database-query",
                "system/condition",
            ]

        dapr_port = os.environ.get("DAPR_HTTP_PORT", "3500")
        function_router_url = (
            f"http://localhost:{dapr_port}/v1.0/invoke/{FUNCTION_ROUTER_APP_ID}/method/execute"
        )

        agent_workflow_id = agent_input.agent_workflow_id or ""

        # Capture metadata for audit/traceability in tool calls.
        parent_execution_id = (
            agent_input.parent_execution_id or agent_input.execution_id or ""
        )
        workflow_id = agent_input.workflow_id or ""
        node_id = agent_input.node_id or "agent"
        node_name = agent_input.node_name or "Agent"

        @function_tool
        async def call_action(action_type: str, input_json: str = "{}") -> dict:
            """Execute one allowed workflow action via the function-router.

            Only call actions listed in `allowed_actions`.
            """

            if action_type not in allowed_actions:
                return {
                    "success": False,
                    "error": f"Action not allowed: {action_type}",
                }

            tool_input: dict
            try:
                parsed = json.loads(input_json) if input_json else {}
                tool_input = parsed if isinstance(parsed, dict) else {"value": parsed}
            except Exception:
                tool_input = {"raw": input_json}

            tool_connection_external_id = (
                action_connection_map.get(action_type)
                or agent_input.connection_external_id
            )

            payload = {
                "function_slug": action_type,
                "execution_id": parent_execution_id,
                "workflow_id": workflow_id or "workflow-builder",
                "node_id": f"{node_id}:{uuid.uuid4().hex[:8]}",
                "node_name": f"{node_name}::{action_type}",
                "input": tool_input,
                "integrations": agent_input.integrations,
                "db_execution_id": agent_input.db_execution_id,
                "connection_external_id": tool_connection_external_id,
            }

            async with httpx.AsyncClient(timeout=300.0) as client:
                resp = await client.post(function_router_url, json=payload)
                if resp.status_code != 200:
                    return {
                        "success": False,
                        "error": f"Function-router error: HTTP {resp.status_code}",
                    }
                return resp.json()

        instructions = f"""You are a workflow automation agent.

You can call tools to perform actions. Only call actions from this allow-list:
{json.dumps(allowed_actions)}

Stop condition (optional):
{agent_input.stop_condition or "(none)"}

Tool usage:
- call_action(action_type, input_json)
- input_json MUST be a JSON string for the action input object (example: "{{\\"endpoint\\":\\"https://example.com\\",\\"httpMethod\\":\\"GET\\"}}")

When you are done, output a JSON object that matches this schema:
- summary: string (what you did and why)
- result_json: string (a JSON string for any structured data you want to return)
"""

        agent = Agent(
            name="WorkflowBuilderAgent",
            model=agent_input.model,
            instructions=instructions,
            tools=[call_action],
            output_type=WorkflowBuilderAgentFinal,
        )

        # run_agent_streamed publishes tool_call/tool_result/llm_chunk events to the stream.
        final: WorkflowBuilderAgentFinal = asyncio.run(
            run_agent_streamed(
                agent,
                input_text=agent_input.prompt,
                workflow_id=agent_workflow_id or parent_execution_id or "agent",
                agent_name="WorkflowBuilderAgent",
                max_turns=agent_input.max_turns,
                publish_fn=publish_workflow_event,
            )
        )

        parsed_result: dict
        try:
            parsed = json.loads(final.result_json) if final.result_json else {}
            parsed_result = parsed if isinstance(parsed, dict) else {"value": parsed}
        except Exception:
            parsed_result = {"raw": final.result_json}

        return {
            "success": True,
            "data": {
                "summary": final.summary,
                "result": parsed_result,
                "agentWorkflowId": agent_workflow_id or parent_execution_id,
            },
        }
    except Exception as e:
        logger.exception("[workflow_builder_agent_run] Activity failed")
        return {"success": False, "error": str(e)}


@wfr.workflow(name="workflow_builder_agent")
def workflow_builder_agent_workflow(
    ctx: wf.DaprWorkflowContext, input_data: Dict[str, Any]
) -> Dict[str, Any]:
    """Durable wrapper workflow: run agent as activity and publish completion event."""

    agent_input = WorkflowBuilderAgentInput(**input_data)
    workflow_id = ctx.instance_id

    # Ensure allowed actions / tools are lists even if the starter passes JSON.
    if not agent_input.allowed_actions:
        agent_input.allowed_actions = _parse_allowed_actions_json(
            input_data.get("allowed_actions_json") or input_data.get("allowedActionsJson")
        )
    if not agent_input.agent_tools:
        agent_input.agent_tools = _parse_agent_tools_json(
            input_data.get("agent_tools_json") or input_data.get("agentToolsJson")
        )

    ctx.set_custom_status(
        json.dumps(
            {
                "phase": "running",
                "progress": 10,
                "message": "Agent started",
            }
        )
    )

    try:
        result = yield ctx.call_activity(
            workflow_builder_agent_run_activity,
            input={
                **agent_input.model_dump(),
                "agent_workflow_id": workflow_id,
            },
        )
    except Exception as e:
        logger.exception("[workflow_builder_agent] Activity raised")
        result = {"success": False, "error": str(e)}

    success = isinstance(result, dict) and result.get("success", False)

    publish_workflow_event(
        workflow_id,
        "agent_completed",
        {
            "phase": "agent",
            "success": bool(success),
            "result": result,
            "error": result.get("error") if isinstance(result, dict) else None,
            "parent_execution_id": agent_input.parent_execution_id,
        },
    )

    ctx.set_custom_status(
        json.dumps(
            {
                "phase": "completed" if success else "failed",
                "progress": 100,
                "message": "Agent completed" if success else "Agent failed",
            }
        )
    )

    return result
