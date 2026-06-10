"""
Execute Action Activity

This activity invokes the function-router service to route function execution
to backend services (fn-system, ap-<piece>-service, durable-agent, etc.).

The function-router supports:
- Registry-based routing with wildcard and default fallback support
- Direct HTTP execution on the in-cluster service
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

from pydantic import BaseModel

from activities.dapr_invoke import dapr_invoke
from content_tracing import io_attributes
from core.config import config
from core.template_resolver import resolve_templates, NodeOutputs
from tracing import apply_workflow_activity_context, set_current_span_attrs, start_activity_span

logger = logging.getLogger(__name__)

FUNCTION_ROUTER_APP_ID = config.FUNCTION_ROUTER_APP_ID


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
    3. Invokes function-router over direct HTTP
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
    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    otel = apply_workflow_activity_context(otel)

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
    # For SW 1.0 piece/action calls, extract the nested 'input' dict as the action input
    # (resolved_config may contain { actionType, input: {...}, metadata: {...} })
    action_input = resolved_config
    if isinstance(resolved_config, dict) and isinstance(resolved_config.get("input"), dict):
        action_input = resolved_config["input"]

    # Extract metadata for AP piece routing (if present in config)
    if isinstance(resolved_config, dict) and isinstance(resolved_config.get("metadata"), dict):
        metadata = resolved_config["metadata"]
        if not connection_external_id:
            connection_external_id = resolved_config.get("connectionExternalId")

    request_payload = {
        "function_slug": action_type,
        "execution_id": execution_id,
        "workflow_id": workflow_id,
        "node_id": node.get("id"),
        "node_name": node_name,
        "input": action_input,
        "integration_id": config.get("integrationId"),
        "integrations": integrations,
        "db_execution_id": db_execution_id,
        "connection_external_id": connection_external_id,
        "ap_project_id": ap_project_id,
        "ap_platform_id": ap_platform_id,
        "_otel": otel,
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

    attrs = {
        "workflow.instance_id": execution_id,
        "workflow.id": workflow_id,
        "workflow.execution.id": db_execution_id or execution_id,
        "workflow.db_execution_id": db_execution_id,
        "workflow.node.id": node.get("id"),
        "workflow.node.name": node_name,
        "workflow.node.action_type": action_type,
        "node.id": node.get("id"),
        "node.name": node_name,
        "action.type": action_type,
    }

    # Mirror onto the durabletask outer span so MLflow / ClickHouse can
    # filter by workflow.id / action.type / node.id without parsing the
    # inner `activity.execute_action` manual span. Also adds richer
    # function-router routing context for debugging.
    set_current_span_attrs({
        "workflow.id": workflow_id,
        "workflow.execution.id": execution_id,
        "workflow.db_execution_id": db_execution_id,
        "node.id": node.get("id"),
        "node.name": node_name,
        "node.action_type": action_type,
        "function_router.app_id": FUNCTION_ROUTER_APP_ID,
        "function_router.method": "execute",
        "function_router.connection_external_id": connection_external_id,
        "function_router.ap_project_id": ap_project_id,
        "function_router.ap_platform_id": ap_platform_id,
        "function_router.is_ap_flow": workflow_id == "ap-flow",
        "function_router.has_resolved_config": bool(resolved_config),
        "function_router.has_integrations": bool(integrations),
    })

    try:
        with start_activity_span("activity.execute_action", otel, attrs):
            # Stamp the resolved action input as `input.value` so the Service
            # Graph drawer shows what was actually requested (gated + redacted).
            set_current_span_attrs(io_attributes("input", action_input))

            # Use per-node timeoutMs if available, otherwise default to 5 min.
            # Add 30s overhead for routing / serialization.
            node_timeout_ms = None
            for src in (resolved_config, config):
                val = src.get("timeoutMs") if isinstance(src, dict) else None
                if val is not None:
                    try:
                        node_timeout_ms = int(val)
                    except (ValueError, TypeError):
                        pass
                    break
            default_http_timeout = int(os.environ.get("EXECUTE_ACTION_TIMEOUT_SECONDS", "300"))
            http_timeout = int(node_timeout_ms / 1000 + 30) if node_timeout_ms else default_http_timeout
            logger.info(
                f"[Execute Action] http_timeout={http_timeout}s node_timeout_ms={node_timeout_ms} "
                f"dapr_app_id={FUNCTION_ROUTER_APP_ID} method=execute "
                f"config_timeoutMs={config.get('timeoutMs') if isinstance(config, dict) else 'N/A'}"
            )

            # Trace context (traceparent / baggage) flows automatically through
            # the Dapr sidecar. function-router's sessionIdFromHeaders reads the
            # Phoenix session attribute from baggage when the explicit
            # x-workflow-session-id header isn't present.
            status, result, resp_text = dapr_invoke(
                FUNCTION_ROUTER_APP_ID,
                "execute",
                request_payload,
                timeout=http_timeout,
                metadata={
                    key: value
                    for key, value in otel.items()
                    if key in ("traceparent", "tracestate", "baggage")
                },
            )

            if status >= 400:
                duration_ms = int((time.time() - start_time) * 1000)
                error_msg = (
                    result.get("error")
                    if isinstance(result, dict) and result.get("error")
                    else f"Function execution failed (status={status}): {resp_text[:300]}"
                )
                logger.error(f"[Execute Action] {error_msg}")
                set_current_span_attrs({
                    "function_router.http_status": status,
                    "function_router.response_chars": len(resp_text or ""),
                    "activity.success": False,
                    "activity.error": error_msg[:500],
                    "activity.duration_ms": duration_ms,
                })
                set_current_span_attrs(
                    io_attributes("output", result if isinstance(result, dict) else resp_text)
                )
                return {
                    "success": False,
                    "error": error_msg,
                    "duration_ms": duration_ms,
                }

            duration_ms = int((time.time() - start_time) * 1000)

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

            # Result-side enrichment so spans show outcome without parsing
            # the JSON output.value blob.
            data = result.get("data")
            data_size = None
            if isinstance(data, (dict, list)):
                try:
                    import json as _json
                    data_size = len(_json.dumps(data, default=str))
                except Exception:
                    data_size = None
            elif isinstance(data, str):
                data_size = len(data)
            set_current_span_attrs({
                "function_router.http_status": status,
                "function_router.response_chars": len(resp_text or ""),
                "activity.success": bool(result.get("success")),
                "activity.error": (result.get("error") or "")[:500] if result.get("error") else None,
                "activity.duration_ms": duration_ms,
                "activity.result_size_chars": data_size,
                "activity.has_pause": bool(result.get("pause")),
            })

            # Stamp the function result payload as `output.value` for the
            # Service Graph drawer (gated + redacted).
            set_current_span_attrs(io_attributes("output", data))

            # Forward pause metadata from the AP piece-runtime (DELAY/WEBHOOK)
            if result.get("pause"):
                activity_result["pause"] = result["pause"]

            return activity_result

    except Exception as e:
        duration_ms = int((time.time() - start_time) * 1000)
        error_msg = f"Unexpected error: {str(e)}"
        logger.error(f"[Execute Action] {error_msg}", exc_info=True)
        return {
            "success": False,
            "error": error_msg,
            "duration_ms": duration_ms,
        }
