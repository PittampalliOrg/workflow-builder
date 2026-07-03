"""
Persist a `workflow_workspace_sessions` row after a successful `workspace/profile`
action. Restores the DB upsert that the legacy TS `workspace-runtime` service
(services/durable-agent/src/service/workspace-session-store.ts, deleted
2026-04-16) used to do on every profile invocation with keepAfterRun=true.

`workspace/*` routing moved to `openshell-agent-runtime` on 2026-04-19 (commit
5c74e218) but the DB persistence was never ported, so every post-04-19 run left
the table empty — breaking the live-preview proxy at
src/routes/api/workflows/executions/[executionId]/sandbox-preview/[previewId]/.

The orchestrator invokes this activity from sw_workflow._handle_call_task right
after the `workspace/profile` execute_action yield completes. Failure MUST NOT
fail the workflow (mirrors track_agent_run.py error handling).
"""

from __future__ import annotations

import json
import logging
from typing import Any

from activities.workflow_data_client import workflow_data_client
from tracing import start_activity_span

logger = logging.getLogger(__name__)


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        s = value.strip().lower()
        if s in {"1", "true", "yes", "y", "on"}:
            return True
        if s in {"0", "false", "no", "n", "off"}:
            return False
    return default


def _unwrap_result(raw: Any) -> dict[str, Any] | None:
    """Walk the standardized action-result envelope down to the inner result dict."""
    current: Any = raw
    for _ in range(6):
        if not isinstance(current, dict):
            return None
        if "workspaceRef" in current:
            return current
        for key in ("result", "data", "output"):
            nested = current.get(key)
            if isinstance(nested, dict):
                current = nested
                break
        else:
            return None
    return current if isinstance(current, dict) else None


def _extract_enabled_tools(inner: dict[str, Any]) -> list[str]:
    raw = inner.get("enabledTools")
    if isinstance(raw, list):
        return [str(v) for v in raw]
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return [str(v) for v in parsed] if isinstance(parsed, list) else []
        except (TypeError, ValueError):
            return []
    return []


def _extract_sandbox_state(inner: dict[str, Any]) -> dict[str, Any]:
    """Build the `sandbox_state` jsonb payload matching the legacy shape."""
    sandbox = inner.get("sandbox") if isinstance(inner.get("sandbox"), dict) else {}
    details = sandbox.get("details") if isinstance(sandbox.get("details"), dict) else {}
    profile = inner.get("workspaceProfile") if isinstance(inner.get("workspaceProfile"), dict) else {}
    state: dict[str, Any] = {
        "backend": inner.get("backend") or sandbox.get("backend") or "openshell",
        "details": {
            "template": details.get("template") or inner.get("sandboxTemplate"),
            "sandboxId": details.get("sandboxId"),
            "sandboxName": details.get("sandboxName") or inner.get("workspaceRef"),
            "executionId": details.get("executionId") or inner.get("executionId"),
            "rootPath": sandbox.get("rootPath") or inner.get("rootPath") or "/sandbox",
            "workspaceRef": inner.get("workspaceRef"),
            "image": details.get("image"),
            "provider": details.get("provider"),
        },
        "rootPath": inner.get("rootPath") or sandbox.get("rootPath") or "/sandbox",
        "workingDirectory": inner.get("workingDirectory") or sandbox.get("workingDirectory") or "/sandbox",
        "keepAfterRun": True,
    }
    ttl = profile.get("ttlSeconds") if isinstance(profile.get("ttlSeconds"), (int, float)) else None
    if ttl is not None:
        state["ttlSeconds"] = int(ttl)
    return state


def persist_workspace_session(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    UPSERT a workflow_workspace_sessions row based on a workspace/profile output.

    Expected fields:
      - workflowExecutionId: str (required)
      - actionType: str (expected "workspace/profile" — other types no-op)
      - result: dict (the raw execute_action result; this function walks the envelope)
      - keepAfterRun: bool (required true — otherwise no-op)
      - taskName: optional str (stored as `name`; defaults to "workspace_profile")
    """
    workflow_execution_id = str(input_data.get("workflowExecutionId") or "").strip()
    action_type = str(input_data.get("actionType") or "").strip().lower()
    keep_after_run = _as_bool(input_data.get("keepAfterRun"), False)
    task_name = str(input_data.get("taskName") or "workspace_profile").strip() or "workspace_profile"
    otel = input_data.get("_otel") or {}

    if action_type != "workspace/profile":
        return {"success": True, "skipped": "action_type"}
    if not workflow_execution_id:
        return {"success": True, "skipped": "missing_execution_id"}
    if not keep_after_run:
        return {"success": True, "skipped": "keep_after_run_false"}

    inner = _unwrap_result(input_data.get("result"))
    if not inner:
        return {"success": True, "skipped": "no_inner_result"}

    workspace_ref = str(inner.get("workspaceRef") or "").strip()
    if not workspace_ref:
        return {"success": True, "skipped": "missing_workspace_ref"}

    root_path = str(inner.get("rootPath") or "/sandbox")
    backend = str(inner.get("backend") or "openshell")
    enabled_tools = _extract_enabled_tools(inner)
    sandbox_state = _extract_sandbox_state(inner)

    attrs = {
        "action.type": "persist_workspace_session",
        "workflow.db_execution_id": workflow_execution_id,
        "workspace.ref": workspace_ref,
    }
    with start_activity_span("activity.persist_workspace_session", otel, attrs):
        try:
            workflow_data_client.upsert_workspace_session(
                {
                    "workspaceRef": workspace_ref,
                    "workflowExecutionId": workflow_execution_id,
                    "name": task_name,
                    "rootPath": root_path,
                    "backend": backend,
                    "enabledTools": enabled_tools,
                    "status": "active",
                    "sandboxState": sandbox_state,
                }
            )
            return {"success": True, "workspace_ref": workspace_ref}
        except Exception as exc:
            logger.warning(
                "[Persist Workspace Session] workflow-data upsert failed for %s (exec=%s): %s",
                workspace_ref,
                workflow_execution_id,
                exc,
            )
            return {"success": False, "workspace_ref": workspace_ref, "error": str(exc)}
