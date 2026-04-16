"""
Call Agent Service Activities

Activities that call durable-agent to run agent actions
as durable Dapr workflows and report completion via pub/sub external events.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from urllib.parse import quote

import httpx

from activities.dapr_invoke import dapr_invoke as _dapr_invoke, dapr_invoke_or_raise as _dapr_invoke_or_raise
from core.config import config
from tracing import start_activity_span

logger = logging.getLogger(__name__)

DAPR_HOST = config.DAPR_HOST
DAPR_HTTP_PORT = config.DAPR_HTTP_PORT
DURABLE_AGENT_APP_ID = config.DURABLE_AGENT_APP_ID
WORKSPACE_RUNTIME_APP_ID = config.WORKSPACE_RUNTIME_APP_ID
DAPR_AGENT_PY_APP_ID = config.DAPR_AGENT_PY_APP_ID
DAPR_AGENT_PY_TESTING_APP_ID = config.DAPR_AGENT_PY_TESTING_APP_ID
CLAUDE_CODE_AGENT_APP_ID = config.CLAUDE_CODE_AGENT_APP_ID
OPENSHELL_AGENT_APP_ID = config.OPENSHELL_AGENT_APP_ID
_SANDBOX_PROFILE_CATALOG: dict[str, dict[str, object]] | None = None
_DEFAULT_SANDBOX_PROFILE_CATALOG: dict[str, dict[str, object]] = {
    "base": {
        "id": "base",
        "backend": "openshell",
        "declaredCapabilities": ["bash", "git"],
        "sandboxImage": "ghcr.io/nvidia/openshell-community/sandboxes/base:latest",
    },
    "node-pnpm": {
        "id": "node-pnpm",
        "backend": "openshell",
        "declaredCapabilities": ["bash", "git", "node", "pnpm"],
        "sandboxImage": "ghcr.io/nvidia/openshell-community/sandboxes/base:latest",
    },
    "node-npm": {
        "id": "node-npm",
        "backend": "openshell",
        "declaredCapabilities": ["bash", "git", "node", "npm"],
        "sandboxImage": "ghcr.io/nvidia/openshell-community/sandboxes/base:latest",
    },
    "python": {
        "id": "python",
        "backend": "openshell",
        "declaredCapabilities": ["bash", "git", "python"],
        "sandboxImage": "ghcr.io/nvidia/openshell-community/sandboxes/base:latest",
    },
    "python-uv": {
        "id": "python-uv",
        "backend": "openshell",
        "declaredCapabilities": ["bash", "git", "python", "uv"],
        "sandboxImage": "ghcr.io/nvidia/openshell-community/sandboxes/base:latest",
    },
}


def _post_json_with_details(
    *,
    client: httpx.Client,
    url: str,
    payload: dict,
    service_label: str,
    headers: dict[str, str] | None = None,
) -> dict:
    response = client.post(url, json=payload, headers=headers)
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


def _string_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [
            str(item).strip().lower()
            for item in value
            if str(item).strip()
        ]
    if isinstance(value, str):
        return [
            item.strip().lower()
            for item in value.split(",")
            if item.strip()
        ]
    return []


def _verify_command_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [line.strip() for line in value.splitlines() if line.strip()]
    return []


def _agent_runtime_from_payload(input_data: dict) -> str:
    agent_config = input_data.get("agentConfig")
    if isinstance(input_data.get("agentRuntime"), str) and input_data["agentRuntime"].strip():
        return input_data["agentRuntime"].strip()
    if isinstance(input_data.get("runtime"), str) and input_data["runtime"].strip():
        return input_data["runtime"].strip()
    if isinstance(agent_config, dict):
        if isinstance(agent_config.get("runtime"), str) and agent_config["runtime"].strip():
            return agent_config["runtime"].strip()
        if (
            isinstance(agent_config.get("agentRuntime"), str)
            and agent_config["agentRuntime"].strip()
        ):
            return agent_config["agentRuntime"].strip()
    return "dapr-agent-py"


def _durable_agent_app_id(input_data: dict) -> str:
    runtime = _agent_runtime_from_payload(input_data)
    if runtime == "dapr-agent-py":
        return DAPR_AGENT_PY_APP_ID
    if runtime == "dapr-agent-py-testing":
        return DAPR_AGENT_PY_TESTING_APP_ID
    return DURABLE_AGENT_APP_ID


def _load_sandbox_profile_catalog() -> dict[str, dict[str, object]]:
    global _SANDBOX_PROFILE_CATALOG
    if _SANDBOX_PROFILE_CATALOG is not None:
        return _SANDBOX_PROFILE_CATALOG
    catalog_path: Path | None = None
    for candidate in (
        Path(__file__).resolve().parent.parent.parent / "config" / "sandbox-profiles.json",
        Path.cwd() / "config" / "sandbox-profiles.json",
    ):
        if candidate.exists():
            catalog_path = candidate
            break
    try:
        parsed = (
            json.loads(catalog_path.read_text(encoding="utf-8"))
            if catalog_path is not None
            else {}
        )
    except Exception:
        parsed = {}
    profiles = parsed.get("profiles") if isinstance(parsed, dict) else {}
    if not isinstance(profiles, dict):
        profiles = {}
    _SANDBOX_PROFILE_CATALOG = {
        str(profile_id): value
        for profile_id, value in profiles.items()
        if isinstance(value, dict)
    }
    if not _SANDBOX_PROFILE_CATALOG:
        _SANDBOX_PROFILE_CATALOG = dict(_DEFAULT_SANDBOX_PROFILE_CATALOG)
    return _SANDBOX_PROFILE_CATALOG


def _resolve_sandbox_profile(input_data: dict, result: dict) -> dict[str, object] | None:
    profile_ref = (
        str(
            input_data.get("sandboxProfileRef")
            or result.get("sandboxProfileRef")
            or result.get("preferredSandboxProfile")
            or result.get("preferredExecutionProfile")
            or result.get("executionProfile")
            or input_data.get("preferredSandboxProfile")
            or input_data.get("preferredExecutionProfile")
            or ""
        ).strip()
        or None
    )
    if profile_ref is None:
        return None
    return _load_sandbox_profile_catalog().get(profile_ref)


def _merge_openshell_capability_validation(
    result: dict,
    input_data: dict,
) -> dict:
    sandbox_profile = _resolve_sandbox_profile(input_data, result)
    backend = (
        str(input_data.get("toolBackend") or "").strip().lower()
        or str((sandbox_profile or {}).get("backend") or "").strip().lower()
    )
    if backend != "openshell":
        return result

    preferred_execution_profile = (
        str(
            result.get("preferredExecutionProfile")
            or result.get("executionProfile")
            or input_data.get("preferredExecutionProfile")
            or ""
        ).strip()
        or None
    )
    sandbox_profile_ref = (
        str(
            input_data.get("sandboxProfileRef")
            or result.get("sandboxProfileRef")
            or result.get("preferredSandboxProfile")
            or preferred_execution_profile
            or ""
        ).strip()
        or None
    )
    required_capabilities = set(
        _string_list(result.get("requiredCapabilities"))
        or _string_list(input_data.get("requiredCapabilities"))
    )
    if preferred_execution_profile == "node-pnpm":
        required_capabilities.update({"bash", "git", "node", "pnpm"})
    elif preferred_execution_profile == "node-npm":
        required_capabilities.update({"bash", "git", "node", "npm"})

    for command in _verify_command_list(input_data.get("verifyCommands")):
        first = shlex.split(command)[0].strip().lower() if command.strip() else ""
        if first == "pnpm":
            required_capabilities.update({"node", "pnpm"})
        elif first in {"npm", "npx"}:
            required_capabilities.update({"node", "npm"})

    available_capabilities = set(_string_list(result.get("availableCapabilities")))
    available_capabilities.update(
        _string_list((sandbox_profile or {}).get("declaredCapabilities"))
    )
    missing_capabilities = sorted(required_capabilities - available_capabilities)

    workspace_profile = (
        dict(result.get("workspaceProfile"))
        if isinstance(result.get("workspaceProfile"), dict)
        else {}
    )
    workspace_profile["backend"] = "openshell"
    workspace_profile["availableCapabilities"] = sorted(available_capabilities)
    workspace_profile["requiredCapabilities"] = sorted(required_capabilities)
    if sandbox_profile_ref:
        workspace_profile["sandboxProfileRef"] = sandbox_profile_ref
    if sandbox_profile and sandbox_profile.get("sandboxImage"):
        workspace_profile["sandboxImage"] = sandbox_profile.get("sandboxImage")
    if preferred_execution_profile:
        workspace_profile["preferredExecutionProfile"] = preferred_execution_profile
        workspace_profile["executionProfile"] = preferred_execution_profile

    merged = dict(result)
    merged["workspaceProfile"] = workspace_profile
    merged["availableCapabilities"] = sorted(available_capabilities)
    merged["requiredCapabilities"] = sorted(required_capabilities)
    merged["missingCapabilities"] = missing_capabilities
    merged["preferredExecutionProfile"] = preferred_execution_profile
    merged["preferredSandboxProfile"] = sandbox_profile_ref
    merged["sandboxProfileRef"] = sandbox_profile_ref
    if preferred_execution_profile:
        merged["executionProfile"] = preferred_execution_profile
    merged["success"] = len(missing_capabilities) == 0
    return merged


def _trace_id_from_traceparent(traceparent: object) -> str | None:
    if not isinstance(traceparent, str):
        return None
    parts = traceparent.strip().split("-")
    if len(parts) != 4:
        return None
    trace_id = parts[1].strip().lower()
    if len(trace_id) != 32:
        return None
    return trace_id


def _trace_id_from_otel(otel_ctx: object) -> str | None:
    if not isinstance(otel_ctx, dict):
        return None
    direct = str(otel_ctx.get("traceId") or otel_ctx.get("trace_id") or "").strip()
    if direct:
        return direct
    return _trace_id_from_traceparent(otel_ctx.get("traceparent"))


def _otel_headers(otel_ctx: object) -> dict[str, str]:
    if not isinstance(otel_ctx, dict):
        return {}
    headers: dict[str, str] = {}
    for key in ("traceparent", "tracestate", "baggage"):
        value = str(otel_ctx.get(key) or "").strip()
        if value:
            headers[key] = value
    return headers


def terminate_durable_runs_by_parent_execution(
    parent_execution_id: str,
    reason: str | None = None,
    cleanup_workspace: bool = True,
) -> dict:
    """
    Terminate active durable agent runs belonging to a parent workflow execution.

    SW 1.0 durable/run can target either the Python durable-agent or the custom
    claude-code-agent harness. Parent cancellation must clean up both runtimes so
    retry and timeout paths do not leave orphaned child workflows.
    """
    parent_execution_id = str(parent_execution_id or "").strip()
    if not parent_execution_id:
        return {"success": False, "error": "parentExecutionId is required"}

    payload = {
        "parentExecutionId": parent_execution_id,
        "reason": reason or "terminated due to parent workflow termination",
        "cleanupWorkspace": cleanup_workspace,
    }
    agents = {
        "durable-agent": DURABLE_AGENT_APP_ID,
        "claude-code-agent": CLAUDE_CODE_AGENT_APP_ID,
    }
    results: dict[str, dict] = {}
    failures: dict[str, str] = {}

    for agent_label, app_id in agents.items():
        try:
            results[agent_label] = _dapr_invoke_or_raise(
                app_id,
                "api/runs/terminate-by-parent",
                payload,
                timeout=20,
                service_label=f"{agent_label} parent termination",
            )
        except Exception as exc:
            message = str(exc)
            if (
                "failed to resolve address" in message
                or "name resolver error" in message
                or "connection refused" in message.lower()
            ):
                logger.info(
                    "[Call Durable Agent Run] Skipping parent durable-run "
                    "termination because %s is unavailable: %s",
                    agent_label,
                    message,
                )
                results[agent_label] = {
                    "success": True,
                    "skipped": True,
                    "reason": f"{agent_label} unavailable",
                }
                continue
            logger.warning(
                "[Call Durable Agent Run] %s parent termination failed: %s",
                agent_label,
                message,
            )
            failures[agent_label] = message

    return {
        "success": not failures,
        "parentExecutionId": parent_execution_id,
        "results": results,
        "failures": failures,
    }


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
    agent_runtime = _agent_runtime_from_payload(input_data)
    run_route = "api/run"
    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "durable/run",
        "workflow.instance_id": input_data.get("parentExecutionId") or "",
        "workflow.id": input_data.get("workflowId") or "",
        "node.id": input_data.get("nodeId") or "",
        "node.name": input_data.get("nodeName") or "",
    }

    with start_activity_span("activity.call_durable_agent_run", otel, attrs):
        if not workspace_ref and agent_runtime not in {
            "dapr-agent-py",
            "dapr-agent-py-testing",
        }:
            return {
                "success": False,
                "error": (
                    "workspaceRef is required. "
                    "SW 1.0 durable/run workflows must provision workspace/profile before the agent step."
                ),
            }
        try:
            return _dapr_invoke_or_raise(
                _durable_agent_app_id(input_data),
                run_route,
                input_data,
                timeout=30,
                service_label="Durable agent run",
            )
        except Exception as e:
            logger.error(f"[Call Durable Agent Run] Failed: {e}")
            return {"success": False, "error": str(e)}


def call_durable_plan(ctx, input_data: dict) -> dict:
    """
    Generate a structured plan on durable-agent service.
    """
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
            return _dapr_invoke_or_raise(
                DURABLE_AGENT_APP_ID,
                "api/plan",
                payload,
                timeout=planning_timeout_seconds,
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
            return _dapr_invoke_or_raise(
                DURABLE_AGENT_APP_ID,
                "api/execute-plan",
                payload,
                timeout=30,
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
            return _dapr_invoke_or_raise(
                DURABLE_AGENT_APP_ID,
                "api/execute-plan-dag",
                payload,
                timeout=30,
                service_label="Durable execute plan DAG",
            )
        except Exception as e:
            logger.error(f"[Call Durable Execute Plan DAG] Failed: {e}")
            return {"success": False, "error": str(e)}


def validate_workspace_capabilities(ctx, input_data: dict) -> dict:
    """
    Validate that a workspace can satisfy the requested execution capabilities.
    """
    workspace_ref = str(input_data.get("workspaceRef") or "").strip()
    if not workspace_ref:
        return {"success": False, "error": "workspaceRef is required"}

    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "workspace/validate-capabilities",
        "workflow.instance_id": input_data.get("parentExecutionId") or "",
        "workflow.execution_id": input_data.get("executionId") or "",
        "workspace.ref": workspace_ref,
        "node.id": input_data.get("nodeId") or "",
        "node.name": input_data.get("nodeName") or "",
    }

    with start_activity_span("activity.validate_workspace_capabilities", otel, attrs):
        try:
            result = _dapr_invoke_or_raise(
                OPENSHELL_AGENT_APP_ID,
                "api/workspaces/capabilities/validate",
                {
                    "workspaceRef": workspace_ref,
                    "requiredCapabilities": input_data.get("requiredCapabilities"),
                    "preferredExecutionProfile": input_data.get(
                        "preferredExecutionProfile"
                    ),
                    "sandboxProfileRef": input_data.get("sandboxProfileRef"),
                    "verifyCommands": input_data.get("verifyCommands"),
                    "toolBackend": input_data.get("toolBackend"),
                },
                timeout=15,
                service_label="Workspace capability validation",
            )
            return _merge_openshell_capability_validation(result, input_data)
        except RuntimeError as exc:
            message = str(exc)
            if "HTTP 404" in message:
                logger.info(
                    "[Validate Workspace Capabilities] Capability validation endpoint "
                    "not available on runtime; skipping preflight until runtime is updated"
                )
                return {
                    "success": True,
                    "skipped": True,
                    "reason": "runtime_capability_validation_unavailable",
                    "workspaceRef": workspace_ref,
                    "requiredCapabilities": input_data.get("requiredCapabilities") or [],
                    "preferredExecutionProfile": input_data.get(
                        "preferredExecutionProfile"
                    ),
                }
            logger.error(f"[Validate Workspace Capabilities] Failed: {message}")
            return {"success": False, "error": message}
        except Exception as e:
            logger.error(f"[Validate Workspace Capabilities] Failed: {e}")
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
            return _dapr_invoke_or_raise(
                _durable_agent_app_id(input_data),
                f"api/run/{quote(agent_workflow_id)}/terminate",
                payload,
                timeout=20,
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
        f"{WORKSPACE_RUNTIME_APP_ID}/method/api/workspaces/cleanup"
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
