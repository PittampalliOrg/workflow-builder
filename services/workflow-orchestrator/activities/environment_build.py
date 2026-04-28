"""
Environment preparation activities.

These are intentionally thin HTTP activities over workflow-builder's internal
environment registry. The Dapr workflow owns the durable wait loop; these
activities only perform idempotent DB/Tekton side effects or status reads.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import requests

from tracing import start_activity_span

logger = logging.getLogger(__name__)


def ensure_environment(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Ensure a validated environment image exists, submitting a build if needed."""
    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else None
    with start_activity_span("activity.ensure_environment", otel):
        payload = input_data.get("input") if isinstance(input_data.get("input"), dict) else input_data
        return _post_internal("/api/internal/environments/ensure", payload)


def check_environment_build(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Read and synchronize the current status of an environment build."""
    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else None
    with start_activity_span("activity.check_environment_build", otel):
        payload = input_data.get("input") if isinstance(input_data.get("input"), dict) else input_data
        return _post_internal("/api/internal/environments/status", payload)


def _post_internal(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    workflow_builder_url = os.environ.get(
        "WORKFLOW_BUILDER_URL",
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
    ).rstrip("/")
    internal_token = os.environ.get("INTERNAL_API_TOKEN", "")
    if not internal_token:
        raise RuntimeError("INTERNAL_API_TOKEN is not configured")

    endpoint = f"{workflow_builder_url}{path}"
    try:
        response = requests.post(
            endpoint,
            json=payload,
            headers={"X-Internal-Token": internal_token},
            timeout=60,
        )
    except requests.exceptions.RequestException as exc:
        logger.warning("[environment_build] HTTP error calling %s: %s", endpoint, exc)
        raise RuntimeError(f"environment build request failed: {exc}") from exc

    if response.status_code >= 400:
        body_preview = response.text[:1200] if response.text else "<empty>"
        raise RuntimeError(
            f"environment build endpoint {path} returned HTTP {response.status_code}: {body_preview}"
        )
    try:
        body = response.json()
    except ValueError as exc:
        raise RuntimeError(f"environment build endpoint returned invalid JSON: {exc}") from exc
    if not isinstance(body, dict):
        raise RuntimeError(
            f"environment build endpoint returned {type(body).__name__}, expected object"
        )
    return body
