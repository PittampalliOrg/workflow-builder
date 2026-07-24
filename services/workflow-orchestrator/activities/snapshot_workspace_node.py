"""
Node-boundary workspace snapshot (durability phase 3). As each top-level node of a
resumable run completes, sw_workflow yields this activity to record a CoW snapshot of the
run's shared CLI workspace at `.snapshots/<key>/<nodeId>` so a later fork-from-node-N can
seed the fork from the workspace as it was AT node N (workspace-consistent) instead of the
run's END state.

Fire-and-forget: it POSTs the BFF snapshot route (which triggers a short SEA Job) and
returns WITHOUT polling. Any failure is swallowed and logged — a missing snapshot only
costs a fallback to end-state seeding and must NEVER fail the node or the run. Kept in an
activity (not inline in the workflow) so the network call stays out of the deterministic
replay path.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import requests

from tracing import start_activity_span

logger = logging.getLogger(__name__)


def snapshot_workspace_node(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Record a node-boundary workspace snapshot (best-effort, never raises).

    Input: { sharedWorkspaceKey, snapshotId (node id), executionId?, _otel? }.
    """
    shared_key = str(input_data.get("sharedWorkspaceKey") or "").strip()
    snapshot_id = str(input_data.get("snapshotId") or "").strip()
    if not shared_key or not snapshot_id:
        return {"success": True, "skipped": "missing_key_or_snapshot"}

    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "snapshot_workspace_node",
        "workspace.key": shared_key,
        "workspace.snapshot_id": snapshot_id,
    }
    with start_activity_span("activity.snapshot_workspace_node", otel, attrs):
        url = os.environ.get(
            "WORKFLOW_BUILDER_URL",
            "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
        ).rstrip("/")
        internal_token = os.environ.get("INTERNAL_API_TOKEN", "")
        if not internal_token:
            logger.warning(
                "[Snapshot] INTERNAL_API_TOKEN unset; skipping snapshot %s/%s",
                shared_key,
                snapshot_id,
            )
            return {"success": True, "skipped": "no_internal_token"}

        try:
            resp = requests.post(
                f"{url}/api/internal/workspace/snapshot",
                json={
                    "sharedWorkspaceKey": shared_key,
                    "snapshotId": snapshot_id,
                    "executionId": str(input_data.get("executionId") or "").strip()
                    or None,
                },
                headers={"X-Internal-Token": internal_token},
                timeout=30,
            )
        except Exception as exc:  # fire-and-forget: never fail the run
            logger.warning(
                "[Snapshot] request failed for %s/%s: %s",
                shared_key,
                snapshot_id,
                exc,
            )
            return {"success": True, "skipped": "request_failed"}

        if resp.status_code >= 400:
            logger.warning(
                "[Snapshot] %s/%s -> HTTP %s: %s",
                shared_key,
                snapshot_id,
                resp.status_code,
                resp.text[:200],
            )
            return {"success": True, "skipped": f"http_{resp.status_code}"}

        body = resp.json() if resp.content else {}
        logger.info(
            "[Snapshot] recorded %s/%s (job=%s)",
            shared_key,
            snapshot_id,
            body.get("job"),
        )
        return {
            "success": True,
            "key": shared_key,
            "snapshotId": snapshot_id,
            "job": body.get("job"),
        }
