"""Activities for durable Crawl4AI job orchestration."""

from __future__ import annotations

import os
from typing import Any

import requests

from tracing import start_activity_span


CRAWL4AI_ADAPTER_URL = os.environ.get(
    "CRAWL4AI_ADAPTER_URL",
    "http://crawl4ai-adapter.workflow-builder.svc.cluster.local:8080",
).rstrip("/")


def crawl4ai_start_job(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Start a Crawl4AI async job through the workflow-owned adapter."""
    otel = input_data.get("_otel") or {}
    payload = input_data.get("input") if isinstance(input_data.get("input"), dict) else {}
    attrs = {
        "crawl4ai.operation": "start_job",
        "workflow.id": input_data.get("workflowId"),
        "node.id": input_data.get("nodeId"),
    }
    with start_activity_span("activity.crawl4ai_start_job", otel, attrs):
        response = requests.post(
            f"{CRAWL4AI_ADAPTER_URL}/crawl/jobs",
            json=payload,
            timeout=30,
        )
        response.raise_for_status()
        result = response.json()
        if not isinstance(result, dict):
            raise RuntimeError("crawl4ai-adapter returned a non-object job response")
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
        response = requests.get(
            f"{CRAWL4AI_ADAPTER_URL}/crawl/jobs/{job_id}",
            timeout=30,
        )
        response.raise_for_status()
        result = response.json()
        if not isinstance(result, dict):
            raise RuntimeError("crawl4ai-adapter returned a non-object status response")
        return result
