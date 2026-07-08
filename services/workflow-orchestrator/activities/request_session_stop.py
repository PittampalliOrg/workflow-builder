"""Lifecycle activity for stopping a dynamic-script child session."""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import requests

logger = logging.getLogger(__name__)


def _headers(internal_token: str, otel: dict[str, Any]) -> dict[str, str]:
    headers = {"X-Internal-Token": internal_token}
    for key in ("traceparent", "tracestate", "baggage"):
        value = otel.get(key)
        if isinstance(value, str) and value.strip():
            headers[key] = value.strip()
    return headers


def request_session_stop(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Ask workflow-builder's lifecycle controller to stop a session.

    The workflow treats this as best-effort for skip: it should not keep the
    parent stuck forever, but it must go through the same lifecycle authority as
    user-initiated stop.
    """

    session_id = str(input_data.get("sessionId") or "").strip()
    if not session_id:
        return {"ok": False, "skipped": True, "reason": "missing sessionId"}
    user_id = str(input_data.get("userId") or "").strip()
    if not user_id:
        return {"ok": False, "skipped": True, "reason": "missing userId"}

    workflow_builder_url = os.environ.get(
        "WORKFLOW_BUILDER_URL",
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
    ).rstrip("/")
    internal_token = os.environ.get("INTERNAL_API_TOKEN", "")
    if not internal_token:
        return {"ok": False, "reason": "INTERNAL_API_TOKEN is not configured"}

    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    payload = {
        "userId": user_id,
        "projectId": input_data.get("projectId"),
        "mode": input_data.get("mode") or "terminate",
        "reason": input_data.get("reason") or "dynamic-script call skipped",
        "graceMs": input_data.get("graceMs"),
    }
    endpoint = f"{workflow_builder_url}/api/internal/sessions/{session_id}/stop"
    last_error = ""
    for attempt in range(1, 4):
        try:
            response = requests.post(
                endpoint,
                json=payload,
                headers=_headers(internal_token, otel),
                timeout=30,
            )
        except requests.exceptions.RequestException as exc:
            last_error = str(exc)
            if attempt < 3:
                time.sleep(attempt)
                continue
            return {"ok": False, "retryable": True, "reason": last_error}

        if response.status_code in {408, 429, 500, 502, 503, 504} and attempt < 3:
            last_error = response.text[:500]
            time.sleep(attempt)
            continue
        try:
            body = response.json()
        except ValueError:
            body = {"text": response.text[:500]}
        return {
            "ok": response.ok,
            "statusCode": response.status_code,
            "body": body,
        }

    return {"ok": False, "retryable": True, "reason": last_error or "stop failed"}
