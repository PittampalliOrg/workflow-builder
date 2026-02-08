"""
Execute Action Activity

This activity invokes the function-router service via Dapr service invocation
to route function execution to OpenFunctions (Knative serverless).

The function-router supports:
- OpenFunctions: Scale-to-zero Knative services (fn-openai, fn-slack, etc.)
- Registry-based routing with wildcard and default fallback support
"""

from __future__ import annotations

import logging
import time
from typing import Any

import requests
from pydantic import BaseModel

from core.config import config
from core.template_resolver import resolve_templates, NodeOutputs

logger = logging.getLogger(__name__)

# Function router dispatches to OpenFunctions (Knative serverless)
FUNCTION_ROUTER_APP_ID = config.FUNCTION_ROUTER_APP_ID
DAPR_HOST = config.DAPR_HOST
DAPR_HTTP_PORT = config.DAPR_HTTP_PORT


class ExecuteActionInput(BaseModel):
    """Input for the execute action activity."""
    node: dict[str, Any]
    nodeOutputs: NodeOutputs
    executionId: str
    workflowId: str
    integrations: dict[str, dict[str, str]] | None = None
    dbExecutionId: str | None = None
    connectionExternalId: str | None = None
    apProjectId: str | None = None
    apPlatformId: str | None = None


class ActivityExecutionResult(BaseModel):
    """Result from action execution."""
    success: bool
    data: Any | None = None
    error: str | None = None
    duration_ms: int = 0


def execute_action(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Execute an action node by calling the function-router service.

    This activity:
    1. Extracts the actionType from the node config
    2. Resolves template variables in the config
    3. Invokes function-router via Dapr service invocation
    4. Returns the execution result

    Args:
        ctx: Dapr workflow context (not used but required by Dapr)
        input_data: ExecuteActionInput as dict

    Returns:
        ActivityExecutionResult as dict
    """
    node = input_data.get("node", {})
    node_outputs = input_data.get("nodeOutputs", {})
    execution_id = input_data.get("executionId", "")
    workflow_id = input_data.get("workflowId", "")
    integrations = input_data.get("integrations")
    db_execution_id = input_data.get("dbExecutionId")
    connection_external_id = input_data.get("connectionExternalId")
    ap_project_id = input_data.get("apProjectId")
    ap_platform_id = input_data.get("apPlatformId")

    # Ensure config is never None
    # Support both flat (node.config) and nested (node.data.config) formats
    config = node.get("config") or {}
    if not config and isinstance(node.get("data"), dict):
        config = node["data"].get("config") or {}

    # Get actionType - the canonical identifier for functions
    action_type = config.get("actionType")

    if not action_type:
        return {
            "success": False,
            "error": f"No actionType specified for node {node.get('id')}. All action nodes must have an actionType configured.",
            "duration_ms": 0,
        }

    # Resolve template variables in the node config
    resolved_config = resolve_templates(config, node_outputs)

    # Use node.label (flat or nested) with fallback to action_type or node.id
    node_label = node.get("label") or ""
    if not node_label and isinstance(node.get("data"), dict):
        node_label = node["data"].get("label", "")
    node_name = node_label or action_type or node.get("id", "unknown")

    # Build the request for function-router
    request_payload = {
        "function_slug": action_type,
        "execution_id": execution_id,
        "workflow_id": workflow_id,
        "node_id": node.get("id"),
        "node_name": node_name,
        "input": resolved_config,
        "integration_id": config.get("integrationId"),
        "integrations": integrations,
        "db_execution_id": db_execution_id,
        "connection_external_id": connection_external_id,
        "ap_project_id": ap_project_id,
        "ap_platform_id": ap_platform_id,
    }

    # Only include node_outputs for WB workflows (not AP flows).
    # AP workflows resolve variables before calling this activity,
    # and AP step_outputs use a different format ({output, type, status})
    # that doesn't match function-router's Zod schema ({label, data}).
    if workflow_id != "ap-flow":
        request_payload["node_outputs"] = node_outputs

    logger.info(
        f"[Execute Action] Invoking function-router for {action_type} "
        f"(nodeId={node.get('id')}, nodeName={node_name})"
    )

    start_time = time.time()

    try:
        # Invoke function-router via Dapr service invocation
        url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/{FUNCTION_ROUTER_APP_ID}/method/execute"

        response = requests.post(
            url,
            json=request_payload,
            timeout=300,  # 5 minute timeout for long-running functions
        )
        response.raise_for_status()

        duration_ms = int((time.time() - start_time) * 1000)
        result = response.json()

        logger.info(
            f"[Execute Action] Function {action_type} completed "
            f"(success={result.get('success')}, duration_ms={duration_ms})"
        )

        activity_result = {
            "success": result.get("success", False),
            "data": result.get("data"),
            "error": result.get("error"),
            "duration_ms": duration_ms,
        }

        # Forward pause metadata from fn-activepieces (DELAY/WEBHOOK)
        if result.get("pause"):
            activity_result["pause"] = result["pause"]

        return activity_result

    except requests.Timeout:
        duration_ms = int((time.time() - start_time) * 1000)
        error_msg = f"Function execution timed out after 300 seconds"
        logger.error(f"[Execute Action] {error_msg}")
        return {
            "success": False,
            "error": error_msg,
            "duration_ms": duration_ms,
        }

    except requests.RequestException as e:
        duration_ms = int((time.time() - start_time) * 1000)
        error_msg = f"Function execution failed: {str(e)}"
        logger.error(f"[Execute Action] {error_msg}")
        return {
            "success": False,
            "error": error_msg,
            "duration_ms": duration_ms,
        }

    except Exception as e:
        duration_ms = int((time.time() - start_time) * 1000)
        error_msg = f"Unexpected error: {str(e)}"
        logger.error(f"[Execute Action] {error_msg}", exc_info=True)
        return {
            "success": False,
            "error": error_msg,
            "duration_ms": duration_ms,
        }
