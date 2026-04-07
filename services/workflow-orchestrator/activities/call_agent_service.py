"""
Call Agent Service Activities

Activities that call durable-agent to run agent actions
as durable Dapr workflows and report completion via pub/sub external events.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shlex
import uuid
import base64
from pathlib import Path
from urllib.parse import quote

import httpx
from dapr.clients import DaprClient

from core.config import config
from tracing import start_activity_span

logger = logging.getLogger(__name__)

DAPR_HOST = config.DAPR_HOST
DAPR_HTTP_PORT = config.DAPR_HTTP_PORT
DURABLE_AGENT_APP_ID = config.DURABLE_AGENT_APP_ID
OPENSHELL_AGENT_APP_ID = config.OPENSHELL_AGENT_APP_ID
OPENSHELL_LANGGRAPH_APP_ID = config.OPENSHELL_LANGGRAPH_APP_ID
OPENSHELL_AGENT_RUNTIME_BASE_URL = (
    str(os.environ.get("OPENSHELL_AGENT_RUNTIME_BASE_URL") or "").strip().rstrip("/")
)

_OPEN_TAG = "<proposed_plan>"
_CLOSE_TAG = "</proposed_plan>"
_PLAN_LINE_PATTERN = re.compile(r"^\s*(?:[-*]|\d+\.)\s+(.*\S)\s*$")
_SANDBOX_PROFILE_CATALOG: dict[str, dict[str, object]] | None = None
_DEFAULT_SANDBOX_PROFILE_CATALOG: dict[str, dict[str, object]] = {
    "base": {
        "id": "base",
        "backend": "local",
        "declaredCapabilities": ["bash", "git"],
        "sandboxImage": None,
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


def _dapr_invoke(app_id: str, method_name: str, payload: dict, *, timeout: int = 300) -> tuple[int, dict, str]:
    """Invoke a Dapr service method via SDK, returning (status_code, json_body, raw_text).

    Mirrors the return signature of _post_json_with_details for easy migration.
    """
    try:
        with DaprClient() as client:
            response = client.invoke_method(
                app_id=app_id,
                method_name=method_name,
                data=json.dumps(payload),
                http_verb="POST",
                timeout=timeout,
            )
            text = response.text() if hasattr(response, 'text') else response.data.decode('utf-8')
            try:
                body = json.loads(text) if text else {}
            except (json.JSONDecodeError, ValueError):
                body = {}
            return 200, body, text
    except Exception as exc:
        error_msg = str(exc)
        return 500, {"error": error_msg}, error_msg


def _dapr_invoke_or_raise(app_id: str, method_name: str, payload: dict, *, timeout: int = 300, service_label: str = "") -> dict:
    """Invoke a Dapr service method via SDK, returning the JSON body or raising RuntimeError.

    Drop-in replacement for _post_json_with_details when used with Dapr service invocation URLs.
    """
    status, body, text = _dapr_invoke(app_id, method_name, payload, timeout=timeout)
    if status >= 400:
        body_preview = text[:1200] if text else "<empty>"
        raise RuntimeError(
            f"{service_label} failed with HTTP {status}: {body_preview}"
        )
    if not isinstance(body, dict):
        raise RuntimeError(
            f"{service_label} returned invalid response type: {type(body).__name__}"
        )
    return body


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


def _extract_proposed_plan_text(text: str) -> str | None:
    if not text:
        return None
    start = text.rfind(_OPEN_TAG)
    if start < 0:
        return None
    content_start = start + len(_OPEN_TAG)
    end = text.find(_CLOSE_TAG, content_start)
    if end < 0:
        candidate = text[content_start:].strip()
        return candidate or None
    candidate = text[content_start:end].strip()
    return candidate or None


def _build_minimal_plan(goal: str, plan_markdown: str) -> dict:
    tasks: list[dict[str, object]] = []
    for index, raw_line in enumerate(plan_markdown.splitlines(), start=1):
        match = _PLAN_LINE_PATTERN.match(raw_line)
        if not match:
            continue
        summary = match.group(1).strip()
        tasks.append(
            {
                "id": str(index),
                "subject": summary[:120],
                "description": summary,
                "status": "pending",
                "blocked": False,
                "blockedBy": [],
                "targetPaths": [],
                "acceptanceCriteria": [],
            }
        )
    if not tasks:
        tasks.append(
            {
                "id": "1",
                "subject": "Execute requested changes",
                "description": goal.strip() or "Execute the approved plan",
                "status": "pending",
                "blocked": False,
                "blockedBy": [],
                "targetPaths": [],
                "acceptanceCriteria": [],
            }
        )
    return {
        "artifactType": "claude_task_graph_v1",
        "goal": goal.strip() or "Execute the requested plan",
        "tasks": tasks,
        "estimated_tool_calls": max(1, len(tasks)),
    }


def _build_openshell_command(input_data: dict) -> str:
    prompt = str(input_data.get("prompt") or "").strip()
    mode = str(input_data.get("mode") or "").strip().lower()
    provider = str(input_data.get("provider") or "").strip().lower()
    model = str(input_data.get("model") or "").strip()
    model_provider = ""
    if "/" in model:
        model_provider, model = [part.strip() for part in model.split("/", 1)]
        model_provider = model_provider.lower()
    cwd = str(input_data.get("sandboxRepoPath") or input_data.get("cwd") or "").strip()
    if mode == "plan_mode":
        prompt = (
            f"{prompt}\n\n"
            "Return only a <proposed_plan>...</proposed_plan> block.\n"
            "Inside the block, produce a short numbered implementation plan.\n"
            "Do not modify files, run write operations, or include any text outside the tags."
        ).strip()
    prompt_b64 = base64.b64encode(prompt.encode("utf-8")).decode("ascii")
    args = [
        "claude",
        "-p",
        '"$WF_PROMPT"',
        "--permission-mode",
        "bypassPermissions",
        "--no-session-persistence",
    ]
    normalized_provider = provider or model_provider
    should_forward_model = bool(model) and (
        model.startswith("claude")
        or normalized_provider in {"anthropic", "claude"}
    )
    if should_forward_model:
        args.extend(["--model", model])
    command = " ".join(
        part if part == '"$WF_PROMPT"' else shlex.quote(part) for part in args
    )
    command = (
        f'WF_PROMPT="$(printf %s {shlex.quote(prompt_b64)} | base64 -d)"; '
        + command
    )
    if cwd:
        return f"cd {shlex.quote(cwd)} && {command}"
    return command


def _build_openshell_session_start_command(
    input_data: dict,
    *,
    session_id: str,
) -> str:
    prompt = str(input_data.get("prompt") or "").strip()
    provider = str(input_data.get("provider") or "").strip().lower()
    model = str(input_data.get("model") or "").strip()
    session_name = str(input_data.get("sessionName") or "").strip()
    model_provider = ""
    if "/" in model:
        model_provider, model = [part.strip() for part in model.split("/", 1)]
        model_provider = model_provider.lower()
    cwd = str(input_data.get("sandboxRepoPath") or input_data.get("cwd") or "").strip()
    prompt_b64 = base64.b64encode(prompt.encode("utf-8")).decode("ascii")
    args = [
        "claude",
        "-p",
        '"$WF_PROMPT"',
        "--permission-mode",
        "bypassPermissions",
        "--session-id",
        session_id,
    ]
    normalized_provider = provider or model_provider
    should_forward_model = bool(model) and (
        model.startswith("claude")
        or normalized_provider in {"anthropic", "claude"}
    )
    if should_forward_model:
        args.extend(["--model", model])
    command = " ".join(
        part if part == '"$WF_PROMPT"' else shlex.quote(part) for part in args
    )
    command = (
        f'WF_PROMPT="$(printf %s {shlex.quote(prompt_b64)} | base64 -d)"; '
        + command
    )
    if cwd:
        return f"cd {shlex.quote(cwd)} && {command}"
    return command


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

    payload = {
        "parentExecutionId": parent_execution_id,
        "reason": reason or "terminated due to parent workflow termination",
        "cleanupWorkspace": cleanup_workspace,
    }
    return _dapr_invoke_or_raise(
        DURABLE_AGENT_APP_ID,
        "api/runs/terminate-by-parent",
        payload,
        timeout=20,
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
            return _dapr_invoke_or_raise(
                DURABLE_AGENT_APP_ID,
                run_route,
                input_data,
                timeout=30,
                service_label="Durable agent run",
            )
        except Exception as e:
            logger.error(f"[Call Durable Agent Run] Failed: {e}")
            return {"success": False, "error": str(e)}


def _should_use_durable_openshell_runtime(input_data: dict) -> bool:
    action_type = str(input_data.get("actionType") or "").strip().lower()
    if action_type == "openshell/session-start":
        return False

    agent_graph = input_data.get("agentGraph")
    if isinstance(agent_graph, dict) and len(agent_graph) > 0:
        return True

    agent_config = input_data.get("agentConfig")
    if not isinstance(agent_config, dict):
        return False

    loop_config = agent_config.get("loop")
    if not isinstance(loop_config, dict):
        return False

    strategy = str(loop_config.get("strategy") or "").strip().lower()
    return strategy == "graph_v1"


def _call_durable_agent_via_openshell(ctx, input_data: dict) -> dict:
    workspace_ref = str(input_data.get("workspaceRef") or "").strip()
    run_route = "api/run-sandboxed" if workspace_ref else "api/run"
    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": str(input_data.get("actionType") or "openshell/run"),
        "workflow.instance_id": input_data.get("parentExecutionId") or "",
        "workflow.db_execution_id": input_data.get("executionId") or "",
        "workflow.id": input_data.get("workflowId") or "",
        "node.id": input_data.get("nodeId") or "",
        "node.name": input_data.get("nodeName") or "",
    }

    with start_activity_span(
        "activity.call_openshell_durable_agent_run",
        otel,
        attrs,
    ):
        try:
            timeout_minutes_raw = input_data.get("timeoutMinutes", 30)
            try:
                timeout_minutes = int(timeout_minutes_raw or 30)
            except (TypeError, ValueError):
                timeout_minutes = 30
            if timeout_minutes <= 0:
                timeout_minutes = 30
            request_timeout_seconds = min(max(timeout_minutes * 60 + 30, 90), 7200)

            payload = {
                "prompt": input_data.get("prompt") or "",
                "mode": input_data.get("mode") or "execute_direct",
                "cwd": input_data.get("sandboxRepoPath") or input_data.get("cwd"),
                "model": input_data.get("model"),
                "maxTurns": input_data.get("maxTurns"),
                "timeoutMinutes": timeout_minutes,
                "stopCondition": input_data.get("stopCondition"),
                "requireFileChanges": input_data.get("requireFileChanges"),
                "cleanupWorkspace": input_data.get("cleanupWorkspace"),
                "instructions": input_data.get("instructions"),
                "tools": input_data.get("tools"),
                "agentGraph": input_data.get("agentGraph"),
                "agentConfig": input_data.get("agentConfig"),
                "loopPolicy": input_data.get("loopPolicy"),
                "workspaceRef": workspace_ref or None,
                "parentExecutionId": input_data.get("parentExecutionId"),
                "executionId": input_data.get("executionId"),
                "workflowId": input_data.get("workflowId"),
                "nodeId": input_data.get("nodeId"),
                "nodeName": input_data.get("nodeName"),
                "waitForCompletion": True,
                "orchestratorManaged": True,
            }
            data = _dapr_invoke_or_raise(
                DURABLE_AGENT_APP_ID,
                run_route,
                payload,
                timeout=request_timeout_seconds,
                service_label="OpenShell durable agent run",
            )
            result = data.get("result") if isinstance(data.get("result"), dict) else {}
            text = (
                str(data.get("text") or "").strip()
                or str(result.get("text") or "").strip()
                or str(result.get("content") or "").strip()
            )
            compact_result = {
                "success": bool(data.get("success", False)),
                "agentWorkflowId": data.get("workflow_id"),
                "daprInstanceId": data.get("dapr_instance_id"),
                "childWorkflowName": "openshell-run",
                "childAppId": DURABLE_AGENT_APP_ID,
                "sandboxName": workspace_ref or input_data.get("sandboxName"),
                "provider": input_data.get("provider"),
                "engine": "durable-agent",
                "text": text,
                "content": text,
                "result": result,
            }
            for field_name in (
                "loopStopReason",
                "loopStopCondition",
                "requiresApproval",
                "usageTotals",
                "compactionApplied",
                "compactionCount",
                "contextOverflowRecovered",
                "lastCompactionReason",
                "fileChanges",
                "snapshotRefs",
                "patch",
                "patchRef",
                "changeSummary",
                "evalResults",
                "traceId",
            ):
                field_value = data.get(field_name)
                if field_value is None:
                    field_value = result.get(field_name)
                if field_value is not None:
                    compact_result[field_name] = field_value
            if data.get("error"):
                compact_result["error"] = data.get("error")
            return compact_result
        except Exception as e:
            logger.error(f"[Call OpenShell Durable Agent Run] Failed: {e}")
            return {"success": False, "error": str(e)}


def call_openshell_agent_run(ctx, input_data: dict) -> dict:
    """
    Run an OpenShell sandboxed Claude-style coding task synchronously.
    """
    _use_direct_url = bool(OPENSHELL_AGENT_RUNTIME_BASE_URL)
    direct_url = (
        f"{OPENSHELL_AGENT_RUNTIME_BASE_URL}/api/v1/agent-runs"
        if _use_direct_url
        else ""
    )
    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": str(input_data.get("actionType") or "openshell/run"),
        "workflow.instance_id": input_data.get("parentExecutionId") or "",
        "workflow.db_execution_id": input_data.get("executionId") or "",
        "workflow.id": input_data.get("workflowId") or "",
        "node.id": input_data.get("nodeId") or "",
        "node.name": input_data.get("nodeName") or "",
    }

    with start_activity_span("activity.call_openshell_agent_run", otel, attrs):
        try:
            action_type = str(input_data.get("actionType") or "openshell/run").strip()
            is_session_start = action_type == "openshell/session-start"
            if _should_use_durable_openshell_runtime(input_data):
                return _call_durable_agent_via_openshell(ctx, input_data)
            timeout_minutes_raw = input_data.get("timeoutMinutes", 30)
            try:
                timeout_minutes = int(timeout_minutes_raw or 30)
            except (TypeError, ValueError):
                timeout_minutes = 30
            if timeout_minutes <= 0:
                timeout_minutes = 30
            request_timeout_seconds = min(max(timeout_minutes * 60 + 30, 90), 7200)
            run_id = str(
                input_data.get("runId")
                or input_data.get("agentWorkflowId")
                or input_data.get("executionId")
                or ""
            ).strip()
            if run_id:
                attrs["agent.workflow_id"] = run_id
            sandbox_name_raw = str(
                input_data.get("sandboxName")
                or input_data.get("workspaceRef")
                or run_id
                or "openshell-run"
            ).strip()
            # OpenShell appends ~30 chars; keep ours <=30 for RFC 1123.
            sandbox_name = re.sub(
                r"[^a-z0-9-]", "-", sandbox_name_raw.lower()
            )[:30].rstrip("-") or "sandbox"
            provider = str(input_data.get("provider") or "").strip() or None
            session_id = (
                str(input_data.get("sessionId") or "").strip()
                if is_session_start
                else ""
            ) or str(uuid.uuid4())
            session_name = (
                str(input_data.get("sessionName") or input_data.get("nodeName") or "").strip()
                if is_session_start
                else ""
            )
            resume_command = f"claude -r {session_id}" if is_session_start else None
            command = (
                _build_openshell_session_start_command(
                    {**input_data, "sessionName": session_name},
                    session_id=session_id,
                )
                if is_session_start
                else _build_openshell_command(input_data)
            )
            otel_headers = _otel_headers(otel)
            trace_id = _trace_id_from_otel(otel)
            payload = {
                "runId": run_id,
                "workflowInstanceId": input_data.get("parentExecutionId"),
                "executionId": input_data.get("executionId"),
                "workflowId": input_data.get("workflowId"),
                "nodeId": input_data.get("nodeId"),
                "nodeName": input_data.get("nodeName"),
                "sandboxName": sandbox_name,
                "provider": provider,
                "engine": input_data.get("engine"),
                "profile": input_data.get("profile"),
                "mode": input_data.get("mode"),
                "model": input_data.get("model"),
                "maxTurns": input_data.get("maxTurns"),
                "keep": _as_bool(input_data.get("keepSandbox"), True),
                "timeoutSeconds": timeout_minutes * 60,
                "repoUrl": input_data.get("repoUrl"),
                "repoBranch": input_data.get("repoBranch"),
                "repoToken": input_data.get("repoToken"),
                "sandboxRepoPath": input_data.get("sandboxRepoPath")
                or input_data.get("cwd"),
                "command": command,
                "artifactRef": input_data.get("artifactRef"),
                "planJson": input_data.get("planJson"),
                "stopCondition": input_data.get("stopCondition"),
                "verifyCommands": input_data.get("verifyCommands"),
                "instructionsOverlay": input_data.get("instructionsOverlay"),
                "toolPolicy": input_data.get("toolPolicy"),
                "writePolicy": input_data.get("writePolicy"),
                "shellPolicy": input_data.get("shellPolicy"),
                "planningThreadId": input_data.get("planningThreadId"),
                "executionThreadId": input_data.get("executionThreadId"),
                "agentConfig": input_data.get("agentConfig"),
                "actionType": action_type,
                "sessionId": session_id if is_session_start else None,
                "sessionName": session_name if is_session_start else None,
                "resumeCommand": resume_command if is_session_start else None,
                "traceId": trace_id,
                "_otel": otel if isinstance(otel, dict) else {},
            }
            if _use_direct_url:
                with httpx.Client(timeout=request_timeout_seconds) as client:
                    data = _post_json_with_details(
                        client=client,
                        url=direct_url,
                        payload=payload,
                        service_label="OpenShell agent run",
                        headers=otel_headers or None,
                    )
            else:
                data = _dapr_invoke_or_raise(
                    OPENSHELL_AGENT_APP_ID,
                    "api/v1/agent-runs",
                    payload,
                    timeout=request_timeout_seconds,
                    service_label="OpenShell agent run",
                )
            result = data.get("result") if isinstance(data.get("result"), dict) else {}
            stdout = str(result.get("stdout") or "").strip()
            stderr = str(result.get("stderr") or "").strip()
            text = stdout or stderr
            plan_markdown = _extract_proposed_plan_text(text)
            agent_progress = (
                data.get("agentProgress") if isinstance(data.get("agentProgress"), dict) else None
            )
            resolved_trace_id = (
                str(data.get("traceId") or "").strip()
                or str(result.get("traceId") or "").strip()
                or (
                    str(agent_progress.get("traceId") or "").strip()
                    if isinstance(agent_progress, dict)
                    else ""
                )
                or trace_id
                or None
            )
            if isinstance(agent_progress, dict) and resolved_trace_id and not agent_progress.get("traceId"):
                agent_progress = {**agent_progress, "traceId": resolved_trace_id}
            compact_result = {
                "success": bool(data.get("status") == "completed" and result.get("ok", True)),
                "agentWorkflowId": data.get("agentWorkflowId") or run_id,
                "daprInstanceId": data.get("daprInstanceId") or run_id,
                "childWorkflowName": "openshell-session-start" if is_session_start else "openshell-run",
                "childAppId": OPENSHELL_AGENT_APP_ID,
                "sandboxName": data.get("sandboxName") or sandbox_name,
                "provider": data.get("provider") or provider,
                "engine": data.get("engine") or input_data.get("engine"),
                "traceId": resolved_trace_id,
                "text": text,
                "content": text,
                "agentProgress": agent_progress,
                "result": result,
            }
            if is_session_start:
                compact_result["prompt"] = str(input_data.get("prompt") or "").strip()
                compact_result["sessionId"] = session_id
                compact_result["resumeCommand"] = (
                    str(data.get("resumeCommand") or "").strip()
                    or str(result.get("resumeCommand") or "").strip()
                    or resume_command
                )
                compact_result["repoPath"] = (
                    str(data.get("repoPath") or "").strip()
                    or str(result.get("repoPath") or "").strip()
                    or str(input_data.get("sandboxRepoPath") or input_data.get("cwd") or "").strip()
                )
                compact_result["sessionName"] = session_name or None
            for field_name in (
                "fileChanges",
                "snapshotRefs",
                "changeSummary",
                "patch",
                "patchRef",
                "changedFiles",
            ):
                field_value = data.get(field_name)
                if field_value is None:
                    field_value = result.get(field_name)
                if field_value is not None:
                    compact_result[field_name] = field_value
            if plan_markdown:
                compact_result["planMarkdown"] = plan_markdown
                compact_result["plan"] = _build_minimal_plan(
                    str(input_data.get("prompt") or "").strip(),
                    plan_markdown,
                )
                compact_result["artifactType"] = "claude_task_graph_v1"
            if not compact_result["success"]:
                compact_result["error"] = stderr or text or "OpenShell run failed"
            return compact_result
        except Exception as e:
            logger.error(f"[Call OpenShell Agent Run] Failed: {e}")
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
                DURABLE_AGENT_APP_ID,
                f"api/run/{quote(agent_workflow_id)}/terminate",
                payload,
                timeout=20,
                service_label="Durable run termination",
            )
        except Exception as e:
            logger.error(f"[Terminate Durable Agent Run] Failed: {e}")
            return {"success": False, "error": str(e)}


def terminate_openshell_langgraph_run(ctx, input_data: dict) -> dict:
    """
    Terminate a specific OpenShell LangGraph observable run.
    """
    agent_workflow_id = str(
        input_data.get("agentWorkflowId") or input_data.get("daprInstanceId") or ""
    ).strip()
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
        "action.type": "openshell-langgraph-observable/run-terminate",
        "workflow.instance_id": input_data.get("parentExecutionId") or "",
        "agent.workflow_id": agent_workflow_id,
        "agent.dapr_instance_id": input_data.get("daprInstanceId") or "",
    }

    with start_activity_span("activity.terminate_openshell_langgraph_run", otel, attrs):
        try:
            return _dapr_invoke_or_raise(
                OPENSHELL_LANGGRAPH_APP_ID,
                f"api/run/{quote(agent_workflow_id)}/terminate",
                payload,
                timeout=20,
                service_label="OpenShell LangGraph run termination",
            )
        except Exception as e:
            logger.error(f"[Terminate OpenShell LangGraph Run] Failed: {e}")
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
        f"{OPENSHELL_AGENT_APP_ID}/method/api/workspaces/cleanup"
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
