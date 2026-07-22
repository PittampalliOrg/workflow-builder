"""
Call Agent Service Activities

Activities that call agent services (dapr-agent-py, claude-code-agent) to run
agent actions as durable Dapr workflows and report completion via pub/sub.
Also hosts workspace-runtime cleanup + sandbox profile helpers.

Historical note: the file name refers to the now-decommissioned TS
durable-agent service. The live agent runtime is dispatched as a Dapr child
workflow from sw_workflow.py (runtime resolved via core.runtime_registry)
rather than via this module. The dead HTTP run/terminate lane
(call_durable_agent_run / terminate_durable_agent_run / _durable_agent_app_id)
has been removed; only terminate_durable_runs_by_parent_execution (live
parent-cancellation fan-out) + the workspace cleanup/validation helpers remain.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

import httpx

from activities.dapr_invoke import dapr_invoke as _dapr_invoke, dapr_invoke_or_raise as _dapr_invoke_or_raise
from core.config import config
from tracing import start_activity_span

logger = logging.getLogger(__name__)

DAPR_HOST = config.DAPR_HOST
DAPR_HTTP_PORT = config.DAPR_HTTP_PORT
WORKSPACE_RUNTIME_APP_ID = config.WORKSPACE_RUNTIME_APP_ID
WORKSPACE_RUNTIME_URL = (config.WORKSPACE_RUNTIME_URL or "").rstrip("/")
WORKSPACE_RETENTION_URL = (config.WORKSPACE_RETENTION_URL or "").rstrip("/")
DAPR_AGENT_PY_APP_ID = config.DAPR_AGENT_PY_APP_ID
DAPR_AGENT_PY_TESTING_APP_ID = config.DAPR_AGENT_PY_TESTING_APP_ID
CLAUDE_AGENT_PY_APP_ID = config.CLAUDE_AGENT_PY_APP_ID
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


# terminate_durable_runs_by_parent_execution was retired in PR2 (lifecycle
# rootcause): it only ever fanned out to the legacy claude-code-agent app-id.
# Per-session agent-runtime children are now terminated/purged explicitly by
# the BFF lifecycle controller (per-app-id), and same-task-hub children by
# Dapr's native parent-child cascade.


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

    if WORKSPACE_RUNTIME_URL:
        url = f"{WORKSPACE_RUNTIME_URL}/api/workspaces/cleanup"
        transport = "http"
    else:
        url = (
            f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/invoke/"
            f"{WORKSPACE_RUNTIME_APP_ID}/method/api/workspaces/cleanup"
        )
        transport = "dapr"
    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "workspace/cleanup",
        "workflow.instance_id": execution_id,
        "workflow.db_execution_id": db_execution_id,
        "workspace.cleanup.transport": transport,
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


def arm_execution_workspace_retention(ctx, input_data: dict) -> dict:
    """Arm terminal-time TTLs for retained workspaces owned by an execution.

    The configured retention provider is the lifecycle authority for Sandbox
    resources. It resolves exact resources from both workflow instance and
    database execution identities, then idempotently transitions only
    ``pending-ttl`` Sandboxes. An empty URL disables the capability. It never
    falls back to the retired workspace-runtime service.

    Transport failures, non-2xx responses, and explicit semantic rejection
    intentionally propagate so the workflow activity retry policy can redrive
    this call.
    """
    execution_id = str(input_data.get("executionId") or "").strip()
    db_execution_id = str(input_data.get("dbExecutionId") or "").strip()
    terminal_at = str(input_data.get("terminalAt") or "").strip()
    if not execution_id and not db_execution_id:
        raise ValueError("executionId or dbExecutionId is required")
    if not terminal_at:
        raise ValueError("terminalAt is required")

    if not WORKSPACE_RETENTION_URL:
        return {
            "success": True,
            "skipped": True,
            "reason": "workspace_retention_disabled",
        }

    url = f"{WORKSPACE_RETENTION_URL}/api/workspaces/retain"
    transport = "http"

    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "workspace/retain",
        "workflow.instance_id": execution_id,
        "workflow.db_execution_id": db_execution_id,
        "workspace.retention.terminal_at": terminal_at,
        "workspace.retention.transport": transport,
    }
    payload = {
        "executionId": execution_id,
        "dbExecutionId": db_execution_id,
        "terminalAt": terminal_at,
    }

    with start_activity_span("activity.arm_execution_workspace_retention", otel, attrs):
        with httpx.Client(timeout=15.0) as client:
            result = _post_json_with_details(
                client=client,
                url=url,
                payload=payload,
                service_label="Workspace retention arming",
            )
            if result.get("success") is False:
                detail = str(result.get("error") or result.get("message") or result)
                raise RuntimeError(
                    f"Workspace retention arming was rejected: {detail[:1200]}"
                )
            if result.get("success") is not True and not isinstance(
                result.get("results"), list
            ):
                raise RuntimeError(
                    "Workspace retention arming returned no positive acknowledgement"
                )
            return result
