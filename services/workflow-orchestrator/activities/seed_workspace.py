"""
Hermetic fork: seed the fork's fresh JuiceFS workspace from the source run's subPath
BEFORE the first resumed node runs — node-type-agnostic (works whether or not the
resumed node spawns an agent pod).

sw_workflow yields this activity at the top of a resumed run (resumeFromNode set +
seedWorkspaceFrom present). It POSTs the BFF `/api/internal/workspace/seed`, which
proxies to sandbox-execution-api's synchronous copy Job. MUST block until the copy is
done; raises on failure so the fork doesn't run against an empty workspace.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import requests

from tracing import start_activity_span

logger = logging.getLogger(__name__)


def seed_workspace(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Copy source workspace → this fork's fresh workspace (idempotent copy-if-empty).

    Input: { workspaceExecutionId (dest), seedWorkspaceFrom (source), _otel? }.
    """
    dest = str(input_data.get("workspaceExecutionId") or "").strip()
    source = str(input_data.get("seedWorkspaceFrom") or "").strip()
    if not dest or not source:
        return {"success": True, "skipped": "missing_dest_or_source"}
    if dest == source:
        return {"success": True, "skipped": "same_subpath"}

    otel = input_data.get("_otel") or {}
    attrs = {
        "action.type": "seed_workspace",
        "workspace.dest": dest,
        "workspace.source": source,
    }
    with start_activity_span("activity.seed_workspace", otel, attrs):
        url = os.environ.get(
            "WORKFLOW_BUILDER_URL",
            "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
        ).rstrip("/")
        internal_token = os.environ.get("INTERNAL_API_TOKEN", "")
        if not internal_token:
            raise RuntimeError("INTERNAL_API_TOKEN is not configured — seed_workspace requires it")
        # The BFF → sandbox-execution-api seed-data Job is synchronous; allow ample time.
        response = requests.post(
            f"{url}/api/internal/workspace/seed",
            json={"workspaceExecutionId": dest, "seedWorkspaceFrom": source},
            headers={"X-Internal-Token": internal_token},
            timeout=170,
        )
        if response.status_code >= 400:
            # Fail loudly: a fork must NOT run against an empty workspace.
            raise RuntimeError(
                f"seed_workspace failed: status={response.status_code} body={response.text[:200]}"
            )
        logger.info("[Seed Workspace] seeded dest=%s from source=%s", dest, source)
        return {"success": True, "dest": dest, "source": source}
