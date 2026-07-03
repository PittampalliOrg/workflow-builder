"""
Record a retained **resumable** workspace so the control plane can track retained
workspace state.

Resumable workflows (`x-workflow-builder.resumable: true`) skip workspace cleanup on
ANY terminal state so a completed run can be forked. That retention is otherwise
implicit (the cleanup-skip in sw_workflow) and leaves no DB record — unlike
`workspace/profile` runs, which `persist_workspace_session` records. This activity
upserts a `workflow_workspace_sessions` row (backend='juicefs') for the JuiceFS
shared workspace.

Best-effort: failure MUST NOT fail the workflow.
"""
from __future__ import annotations

import logging
from typing import Any

from activities.workflow_data_client import workflow_data_client
from tracing import start_activity_span

logger = logging.getLogger(__name__)


def register_resumable_workspace(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Upsert a retained-resumable-workspace registry row.

    Expected input: { workspaceRef (the JuiceFS workspace key), dbExecutionId, _otel? }.
    """
    workspace_ref = str(input_data.get("workspaceRef") or "").strip()
    execution_id = str(
        input_data.get("dbExecutionId") or input_data.get("workflowExecutionId") or ""
    ).strip()
    if not workspace_ref or not execution_id:
        return {"success": True, "skipped": "missing_ref_or_execution"}

    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "register_resumable_workspace",
        "workspace.ref": workspace_ref,
        "workflow.db_execution_id": execution_id,
    }
    with start_activity_span("activity.register_resumable_workspace", otel, attrs):
        try:
            workflow_data_client.upsert_workspace_session(
                {
                    "workspaceRef": workspace_ref,
                    "workflowExecutionId": execution_id,
                    "name": execution_id,
                    "rootPath": "/sandbox/work",
                    "backend": "juicefs",
                    "enabledTools": [],
                    "status": "active",
                    "sandboxState": {},
                }
            )
            return {"success": True, "workspace_ref": workspace_ref}
        except Exception as exc:  # noqa: BLE001 — best-effort, never fail the run
            logger.warning(
                "[Register Resumable Workspace] workflow-data upsert failed for %s (exec=%s): %s",
                workspace_ref,
                execution_id,
                exc,
            )
            return {"success": False, "workspace_ref": workspace_ref, "error": str(exc)}
