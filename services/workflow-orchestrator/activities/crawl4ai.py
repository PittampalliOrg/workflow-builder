"""Activities for durable Crawl4AI job orchestration.

Dapr workflow durability invariants:

1. **Deterministic jobId.** The orchestrator computes
   ``j_<sha256(workflowId|nodeId|url)>[:32]`` and injects it into the POST
   body. Adapter-side, this becomes the primary key in ``crawl4ai_jobs`` —
   so an activity retry (via Dapr's per-activity retry policy) hits the
   same row. The adapter returns the existing record for terminal/in-flight
   states or resets-and-re-kicks a FAILED row, never starting duplicate
   work.

2. **No client-side state.** This activity is pure — input → HTTP →
   output. The adapter persists everything (job state + cache) so this
   activity can be re-run on a different orchestrator pod, replayed from
   workflow history, or retried, all without divergence.

3. **Polling uses durable timers.** The caller (`_run_durable_crawl4ai_job`)
   wraps repeated `crawl4ai_get_job_status` calls with `ctx.create_timer`
   between polls; the timer state is part of the workflow checkpoint.
"""

from __future__ import annotations

import hashlib
import os
from typing import Any

import requests

from content_tracing import io_attributes
from tracing import set_current_span_attrs, start_activity_span


CRAWL4AI_ADAPTER_URL = os.environ.get(
    "CRAWL4AI_ADAPTER_URL",
    "http://crawl4ai-adapter.workflow-builder.svc.cluster.local:8080",
).rstrip("/")


def _deterministic_job_id(input_data: dict[str, Any], payload: dict[str, Any]) -> str:
    """Stable id from (workflowId, nodeId, url). Re-computed on every
    activity attempt — equal inputs produce equal jobId, so adapter
    deduplicates and the activity is fully idempotent under Dapr retry."""
    seed = "|".join(
        [
            str(input_data.get("workflowId") or ""),
            str(input_data.get("nodeId") or ""),
            str(payload.get("url") or ""),
        ]
    )
    return "j_" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:32]


def crawl4ai_start_job(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Start a Crawl4AI async job through the workflow-owned adapter."""
    otel = input_data.get("_otel") or {}
    payload = input_data.get("input") if isinstance(input_data.get("input"), dict) else {}
    payload = dict(payload)  # copy — don't mutate the activity input map.
    if not payload.get("jobId"):
        payload["jobId"] = _deterministic_job_id(input_data, payload)
    attrs = {
        "crawl4ai.operation": "start_job",
        "workflow.id": input_data.get("workflowId"),
        "node.id": input_data.get("nodeId"),
        "crawl4ai.job_id": payload["jobId"],
    }
    with start_activity_span("activity.crawl4ai_start_job", otel, attrs):
        set_current_span_attrs(io_attributes("input", payload))
        response = requests.post(
            f"{CRAWL4AI_ADAPTER_URL}/crawl/jobs",
            json=payload,
            timeout=30,
        )
        response.raise_for_status()
        result = response.json()
        if not isinstance(result, dict):
            raise RuntimeError("crawl4ai-adapter returned a non-object job response")
        # Always echo back our deterministic id so the polling activity uses it.
        if not result.get("jobId"):
            result["jobId"] = payload["jobId"]
        set_current_span_attrs(io_attributes("output", result))
        return result


def crawl4ai_get_job_status(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Fetch Crawl4AI async job status through the workflow-owned adapter."""
    job_id = str(input_data.get("jobId") or input_data.get("job_id") or "").strip()
    if not job_id:
        raise RuntimeError("jobId is required")
    otel = input_data.get("_otel") or {}
    attrs = {
        "crawl4ai.operation": "get_job_status",
        "crawl4ai.job_id": job_id,
        "workflow.id": input_data.get("workflowId"),
        "node.id": input_data.get("nodeId"),
    }
    with start_activity_span("activity.crawl4ai_get_job_status", otel, attrs):
        set_current_span_attrs(io_attributes("input", {"jobId": job_id}))
        response = requests.get(
            f"{CRAWL4AI_ADAPTER_URL}/crawl/jobs/{job_id}",
            timeout=30,
        )
        response.raise_for_status()
        result = response.json()
        if not isinstance(result, dict):
            raise RuntimeError("crawl4ai-adapter returned a non-object status response")
        # The completed status payload carries the crawled markdown + the
        # schema-extracted `data` — the actual research content. Capture it.
        set_current_span_attrs(io_attributes("output", result))
        return result
