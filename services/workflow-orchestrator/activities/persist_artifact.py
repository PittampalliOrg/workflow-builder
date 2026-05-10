"""Activity: persist a typed workflow artifact to the BFF for run-detail UI rendering.

The orchestrator's ``_handle_call_task`` (and other task dispatchers) walk
an optional ``artifacts: [...]`` list on the SW 1.0 task spec after the
task's result is finalised. For each entry, this activity HTTP-POSTs to
``/api/internal/workflows/executions/<id>/artifacts``.

Dapr durability invariants (parallels ``crawl4ai_start_job``):

1. **Deterministic id.** Computed by the caller from
   ``sha256(workflowId|executionId|nodeId|kind|title)[:24]``; passed
   through as the row PK. The BFF UPSERTs on conflict so an activity
   retry is a no-op (or an idempotent overwrite if the producer
   recomputed the payload).

2. **No client-side state.** Pure: input → HTTP → output. Replays
   from workflow history are safe.

3. **Failure is non-fatal at the workflow level.** Persisting an
   artifact is observability — it must never break the workflow it
   describes. The activity raises only on programmer errors (missing
   internal token, malformed input). Network / 4xx / 5xx are logged
   but not propagated; the workflow proceeds.
"""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Any

import requests

from tracing import start_activity_span

logger = logging.getLogger("activities.persist_artifact")


def deterministic_artifact_id(
    workflow_id: str | None,
    execution_id: str,
    node_id: str | None,
    kind: str,
    title: str,
) -> str:
    """Stable id from the task identity + artifact slot. Same inputs → same id,
    so activity retries collapse to UPSERTs on the same row."""
    seed = "|".join(
        [
            str(workflow_id or ""),
            str(execution_id or ""),
            str(node_id or ""),
            str(kind or ""),
            str(title or ""),
        ]
    )
    return "wfa_" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]


def persist_workflow_artifact(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Persist one workflow artifact to the BFF's internal API.

    Expected ``input_data`` shape::

        {
            "executionId":   "<workflow_executions.id>",   # required
            "workflowId":    "<workflow id>",
            "nodeId":        "<task path or null>",
            "slot":          "primary" | "secondary" | "aux" | None,
            "kind":          "markdown" | "json" | ...,    # required
            "title":         "<human label>",              # required
            "description":   "<one-line subtitle>" | None,
            "inlinePayload": <jsonable> | None,
            "fileId":        "<files.id>" | None,
            "contentType":   "text/markdown" | ... | None,
            "sizeBytes":     int | None,
            "metadata":      {...} | None,
            "_otel":         {...},                        # injected by caller
        }
    """
    execution_id = str(input_data.get("executionId") or "").strip()
    if not execution_id:
        raise RuntimeError("persist_workflow_artifact: executionId is required")
    kind = str(input_data.get("kind") or "").strip()
    if not kind:
        raise RuntimeError("persist_workflow_artifact: kind is required")
    title = str(input_data.get("title") or "").strip()
    if not title:
        raise RuntimeError("persist_workflow_artifact: title is required")

    artifact_id = str(input_data.get("artifactId") or "").strip() or deterministic_artifact_id(
        input_data.get("workflowId"),
        execution_id,
        input_data.get("nodeId"),
        kind,
        title,
    )

    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else None
    attrs = {
        "artifact.id": artifact_id,
        "artifact.kind": kind,
        "artifact.slot": input_data.get("slot"),
        "workflow.id": input_data.get("workflowId"),
        "node.id": input_data.get("nodeId"),
    }
    with start_activity_span("activity.persist_workflow_artifact", otel, attrs):
        url = os.environ.get(
            "WORKFLOW_BUILDER_URL",
            "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
        ).rstrip("/")
        internal_token = os.environ.get("INTERNAL_API_TOKEN", "")
        if not internal_token:
            raise RuntimeError(
                "INTERNAL_API_TOKEN is not configured — persist_workflow_artifact requires it"
            )

        body: dict[str, Any] = {
            "id": artifact_id,
            "nodeId": input_data.get("nodeId"),
            "slot": input_data.get("slot"),
            "kind": kind,
            "title": title,
            "description": input_data.get("description"),
            "inlinePayload": input_data.get("inlinePayload"),
            "fileId": input_data.get("fileId"),
            "contentType": input_data.get("contentType"),
            "sizeBytes": input_data.get("sizeBytes"),
            "metadata": input_data.get("metadata"),
        }

        try:
            response = requests.post(
                f"{url}/api/internal/workflows/executions/{execution_id}/artifacts",
                json=body,
                headers={"X-Internal-Token": internal_token},
                timeout=10,
            )
            if response.status_code >= 400:
                # Don't raise — observability must not break the workflow.
                logger.warning(
                    "persist_workflow_artifact failed: status=%s body=%s artifactId=%s",
                    response.status_code,
                    response.text[:200],
                    artifact_id,
                )
                return {"ok": False, "id": artifact_id, "status": response.status_code}
            return {"ok": True, "id": artifact_id}
        except Exception as exc:
            # Best-effort. Workflow continues regardless.
            logger.warning(
                "persist_workflow_artifact transport error: %s artifactId=%s", exc, artifact_id
            )
            return {"ok": False, "id": artifact_id, "error": str(exc)}
