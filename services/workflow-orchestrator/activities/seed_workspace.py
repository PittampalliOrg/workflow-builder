"""
Hermetic fork: seed the fork's fresh JuiceFS workspace from the source run's subPath
BEFORE the first resumed node runs — node-type-agnostic (works whether or not the
resumed node spawns an agent pod).

sw_workflow yields this activity at the top of a resumed run (resumeFromNode set +
seedWorkspaceFrom present). It POSTs the BFF `/api/internal/workspace/seed` to START an
async CoW-clone Job (sandbox-execution-api `juicefs clone`, root-mounted), then POLLS
`?status` until the Job finishes. Async because cloning a many-small-file workspace is
metadata-bound on Postgres-backed JuiceFS and a synchronous wait blew the request
timeout. Raises on failure/timeout so the fork doesn't run against an empty workspace.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

import requests

from tracing import start_activity_span

logger = logging.getLogger(__name__)

# Clone is O(files) on Postgres-backed JuiceFS metadata; bound generously so even a
# large workspace seeds, while still failing a genuinely stuck Job.
_SEED_POLL_TIMEOUT_SECONDS = int(os.environ.get("SEED_WORKSPACE_POLL_TIMEOUT_SECONDS", "1500"))
_SEED_POLL_INTERVAL_SECONDS = int(os.environ.get("SEED_WORKSPACE_POLL_INTERVAL_SECONDS", "5"))


def seed_workspace(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """CoW-clone source workspace → this fork's fresh workspace (idempotent copy-if-empty).

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
        headers = {"X-Internal-Token": internal_token}

        # 1. Start the async clone Job.
        start = requests.post(
            f"{url}/api/internal/workspace/seed",
            json={"workspaceExecutionId": dest, "seedWorkspaceFrom": source},
            headers=headers,
            timeout=60,
        )
        if start.status_code >= 400:
            raise RuntimeError(
                f"seed_workspace start failed: status={start.status_code} body={start.text[:200]}"
            )
        started = start.json() if start.content else {}
        if started.get("done") or started.get("skipped"):
            logger.info("[Seed Workspace] no-op (%s) dest=%s", started.get("skipped"), dest)
            return {"success": True, "dest": dest, "source": source, "skipped": started.get("skipped")}
        job = str(started.get("job") or "").strip()
        namespace = started.get("namespace")
        if not job:
            raise RuntimeError(f"seed_workspace start returned no job: {started}")

        # 2. Poll until the clone Job finishes.
        deadline = time.monotonic() + _SEED_POLL_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            time.sleep(_SEED_POLL_INTERVAL_SECONDS)
            poll = requests.post(
                f"{url}/api/internal/workspace/seed?status=1",
                json={"job": job, "namespace": namespace},
                headers=headers,
                timeout=30,
            )
            if poll.status_code == 404:
                # TTL-reaped after a fast success, or vanished — treat as done.
                logger.info("[Seed Workspace] job %s not found on poll; assuming complete", job)
                return {"success": True, "dest": dest, "source": source, "job": job}
            if poll.status_code >= 400:
                raise RuntimeError(
                    f"seed_workspace poll failed: status={poll.status_code} body={poll.text[:200]}"
                )
            status = poll.json() if poll.content else {}
            if status.get("failed"):
                raise RuntimeError(f"seed_workspace clone job {job} failed")
            if status.get("succeeded") or status.get("done"):
                logger.info("[Seed Workspace] cloned dest=%s from source=%s (job=%s)", dest, source, job)
                return {"success": True, "dest": dest, "source": source, "job": job}

        raise RuntimeError(
            f"seed_workspace clone job {job} did not finish in {_SEED_POLL_TIMEOUT_SECONDS}s"
        )
