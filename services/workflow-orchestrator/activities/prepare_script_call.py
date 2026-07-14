"""Prepare one dynamic-script call for durable dispatch.

This activity intentionally owns all non-deterministic dispatch preparation:
runtime-registry resolution, BFF session provisioning, and workflow-ref lookup.
The parent workflow receives a replay-stable descriptor and then schedules the
child workflow from orchestration code.
"""

from __future__ import annotations

import logging
from typing import Any

from activities.resolve_script_workflow import resolve_script_workflow
from activities.spawn_session import spawn_session_for_workflow

logger = logging.getLogger(__name__)


def prepare_script_call(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    # Import inside the activity to keep activities package auto-discovery from
    # creating an import cycle at module load time.
    from workflows.script_agent_dispatch import (  # noqa: PLC0415
        DYNAMIC_SCRIPT_WORKFLOW_NAME,
        SESSION_WORKFLOW_NAME,
        _build_agent_config,
        _build_initial_message,
        script_child_instance_id,
    )
    from workflows.sw_workflow import (  # noqa: PLC0415
        _resolve_native_agent_runtime,
    )

    call_id = str(input_data.get("callId") or "").strip()
    spec = input_data.get("spec") if isinstance(input_data.get("spec"), dict) else {}
    exec_id = str(input_data.get("executionId") or "").strip()
    parent_instance_id = str(input_data.get("parentInstanceId") or "").strip()
    meta = input_data.get("meta") if isinstance(input_data.get("meta"), dict) else {}
    defaults = (
        input_data.get("defaults") if isinstance(input_data.get("defaults"), dict) else {}
    )
    limits = input_data.get("limits") if isinstance(input_data.get("limits"), dict) else {}
    workflow_id = input_data.get("workflowId")
    user_id = input_data.get("userId")
    project_id = input_data.get("projectId")
    budget_total = input_data.get("budgetTotal")
    features = input_data.get("features") if isinstance(input_data.get("features"), dict) else None
    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}

    retries = int(spec.get("retries") or 0)
    child_instance_id = script_child_instance_id(parent_instance_id, call_id, retries)
    opts = spec.get("opts") if isinstance(spec.get("opts"), dict) else {}
    kind = spec.get("kind") or "agent"

    if kind == "workflow":
        workflow_ref = str(spec.get("workflowRef") or opts.get("workflowRef") or "").strip()
        resolved = resolve_script_workflow(ctx, {"workflowRef": workflow_ref, "_otel": otel})
        if not isinstance(resolved, dict) or not resolved.get("success"):
            reason = (
                (resolved or {}).get("error") if isinstance(resolved, dict) else resolved
            )
            logger.warning(
                "[script-dispatch] workflow() ref %r could not be resolved: %s",
                workflow_ref,
                reason,
            )
            return {
                "kind": "dispatchError",
                "callId": call_id,
                "childInstanceId": child_instance_id,
                "dispatchError": (
                    f"workflow() could not resolve {workflow_ref!r}"
                    + (f": {reason}" if reason else "")
                ),
            }

        child_input = {
            "executionId": exec_id,
            "script": resolved.get("script"),
            "scriptSha256": resolved.get("scriptSha256"),
            "meta": resolved.get("meta") or {},
            "budgetTotal": budget_total,
            "nested": True,
            "journalImportFromExecutionId": None,
            "limits": limits,
            "defaults": defaults,
            "workflowId": workflow_id,
            "userId": user_id,
            "projectId": project_id,
            "_otel": otel,
        }
        if "args" in spec:
            child_input["args"] = spec.get("args")
        # Nested children inherit the parent's deployment capabilities so
        # action()/sleep()/approve() work at every nesting level.
        if features:
            child_input["features"] = features
        return {
            "kind": "workflow",
            "callId": call_id,
            "childInstanceId": child_instance_id,
            "childWorkflowName": DYNAMIC_SCRIPT_WORKFLOW_NAME,
            "childInput": child_input,
        }

    agent_runtime = ""
    if isinstance(opts.get("agentType"), str) and opts.get("agentType").strip():
        agent_runtime = opts["agentType"].strip()
    elif isinstance(defaults.get("agentRuntime"), str) and defaults.get("agentRuntime").strip():
        agent_runtime = defaults["agentRuntime"].strip()

    flattened_args = {"agentRuntime": agent_runtime} if agent_runtime else {}
    agent_config = _build_agent_config(opts, defaults, agent_runtime, meta)
    try:
        resolved_runtime, target = _resolve_native_agent_runtime(
            flattened_args, agent_config
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[script-dispatch] agent() call %s: could not resolve agentType %r (%s); "
            "journaling this call as null.",
            call_id,
            agent_runtime or "(default)",
            exc,
        )
        return {
            "kind": "null",
            "callId": call_id,
            "childInstanceId": child_instance_id,
            "reason": str(exc),
        }

    agent_config["runtime"] = resolved_runtime
    label = str(opts.get("label") or "").strip() or str(call_id)[:8]
    workspace_ref = f"ws_script_{exec_id}" if opts.get("isolation") == "shared" else None
    try:
        timeout_minutes = (
            int(defaults.get("timeoutMinutes")) if defaults.get("timeoutMinutes") else 30
        )
    except (TypeError, ValueError):
        timeout_minutes = 30

    bridge_payload = {
        "sessionId": child_instance_id,
        "workflowId": workflow_id,
        "nodeId": call_id,
        "nodeName": label,
        "workflowExecutionId": exec_id,
        "parentExecutionId": parent_instance_id,
        "agentConfig": agent_config,
        "vaultIds": [],
        "initialMessage": _build_initial_message(
            spec,
            structured_tool=agent_config.get("structuredOutputMode") == "tool",
        ),
        "title": f"{meta.get('name') or 'script'} · {label}",
        "workspaceRef": workspace_ref,
        "timeoutMinutes": timeout_minutes,
        "maxIterations": None,
        "userId": user_id,
        "projectId": project_id,
        "_otel": otel,
    }
    # Non-blocking (concurrency plan P2): one ensure POST; the pump owns the
    # durable-timer readiness wait via wait_for_prepared_agent_hosts, keyed on
    # the bridgePayload/agentHostStatus this descriptor carries back.
    bridge_result = spawn_session_for_workflow(ctx, bridge_payload)
    if isinstance(bridge_result, dict) and bridge_result.get("cancelled"):
        return {
            "kind": "null",
            "callId": call_id,
            "childInstanceId": child_instance_id,
            "reason": bridge_result.get("error") or "session bridge refused",
        }
    bridge_child_input = (
        bridge_result.get("childInput") if isinstance(bridge_result, dict) else None
    )
    if not isinstance(bridge_child_input, dict):
        raise RuntimeError(
            f"script↔session bridge: invalid bridge_result for {child_instance_id}"
        )

    bridge_app_id = target["app_id"]
    returned_app_id = bridge_result.get("agentAppId") if isinstance(bridge_result, dict) else None
    if isinstance(returned_app_id, str) and returned_app_id.strip():
        bridge_app_id = returned_app_id.strip()

    child_input = {
        **bridge_child_input,
        "workflowId": workflow_id,
        "workflowExecutionId": exec_id,
        "dbExecutionId": exec_id,
        "nodeId": call_id,
        "nodeName": label,
        "agentId": bridge_result.get("agentId") if isinstance(bridge_result, dict) else None,
        "agentAppId": bridge_app_id,
        "_otel": otel,
    }
    return {
        "kind": "agent",
        "callId": call_id,
        "childInstanceId": child_instance_id,
        "childWorkflowName": target.get("dispatch_workflow_name") or SESSION_WORKFLOW_NAME,
        "childInput": child_input,
        "appId": bridge_app_id,
        "agentHostStatus": bridge_result.get("agentHostStatus")
        if isinstance(bridge_result, dict)
        else None,
        "bridgePayload": bridge_payload,
    }
