"""Fire-and-poll dispatch for cross-app-id ``durable/run`` child session workflows.

These activities let the SW-interpreter parent START a per-session agent
``session_workflow`` on a DIFFERENT Dapr app-id (a separate task hub) and POLL
its status/output — WITHOUT holding an outstanding cross-app sub-orchestration.

Why route through the BFF: per-session Kueue sandboxes get only a headless
service (no Dapr ``<appid>-dapr`` service), so the orchestrator CANNOT reach them
via Dapr service-invoke (``call_child_workflow`` worked only because Dapr
workflow sub-orchestration routes via placement, not DNS). The BFF discovers the
sandbox's pod URL (``waitForAgentWorkflowHostAppReady``), so these activities
HTTP the BFF's ``/api/internal/agent-runtime/{start,status,terminate}`` endpoints
which proxy to the sandbox. See docs/workflow-lifecycle-termination.md +
[[project_workflow_run_stop_crossapp_child_wedge]].

Keeping the parent's durable history same-task-hub (timers + activities + one
``workflow.cancel`` subscription, no cross-app sub-orchestration) is what lets a
user Stop unwind the parent to a clean terminal state instead of wedging /
hot-looping.
"""
from __future__ import annotations

import json
import os
from typing import Any

import requests

from content_tracing import io_attributes
from tracing import set_current_span_attrs, start_activity_span


def _bff_base_url() -> str:
    return os.environ.get(
        "WORKFLOW_BUILDER_URL",
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
    ).rstrip("/")


def _internal_token() -> str:
    return os.environ.get("INTERNAL_API_TOKEN", "")


def _bff_post(path: str, body: dict[str, Any], *, timeout: int = 60) -> tuple[int, dict[str, Any]]:
    """POST to a BFF internal endpoint with the internal token. Returns
    (status_code, json_body); all transport errors normalize to (0, {})."""
    try:
        resp = requests.post(
            f"{_bff_base_url()}{path}",
            json=body,
            headers={"Content-Type": "application/json", "X-Internal-Token": _internal_token()},
            timeout=timeout,
        )
        try:
            data = resp.json() if resp.content else {}
        except (json.JSONDecodeError, ValueError):
            data = {}
        return resp.status_code, (data if isinstance(data, dict) else {})
    except Exception:  # noqa: BLE001 — transport error -> caller treats as transient
        return 0, {}


def start_session_workflow(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Fire-and-forget start of a per-session ``session_workflow`` via the BFF.
    Idempotent (the sandbox spawn reuses an existing instanceId). Returns
    ``{ok, notReady}``; ``notReady`` means the sandbox isn't reachable yet so the
    workflow retries the start."""
    app_id = str(input_data.get("agentAppId") or "").strip()
    instance_id = str(input_data.get("instanceId") or "").strip()
    payload = input_data.get("payload") if isinstance(input_data.get("payload"), dict) else {}
    otel = input_data.get("_otel") or {}
    if not app_id or not instance_id:
        raise RuntimeError("start_session_workflow requires agentAppId + instanceId")
    attrs = {"agent.app_id": app_id, "agent.instance_id": instance_id, "agent.operation": "start"}
    with start_activity_span("activity.start_session_workflow", otel, attrs):
        set_current_span_attrs(io_attributes("input", {"instanceId": instance_id, "agentAppId": app_id}))
        status, body = _bff_post(
            "/api/internal/agent-runtime/start",
            {"agentAppId": app_id, "instanceId": instance_id, "payload": payload},
        )
        if status == 200 and body.get("ok"):
            result = {"ok": True, "notReady": False, "instanceId": instance_id}
        elif status == 0 or status >= 500 or body.get("notReady"):
            # BFF unreachable / sandbox not ready -> retry at the workflow level.
            result = {"ok": False, "notReady": True, "status": status, "error": str(body.get("error") or "")[:300]}
        else:
            result = {"ok": False, "notReady": False, "status": status, "error": str(body.get("error") or "")[:300]}
        set_current_span_attrs(io_attributes("output", result))
        return result


def poll_session_workflow_status(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Poll a per-session ``session_workflow``'s runtime status + output via the
    BFF. NEVER raises — transient errors return ``complete=False`` so the parent
    poll loop keeps trying."""
    app_id = str(input_data.get("agentAppId") or "").strip()
    instance_id = str(input_data.get("instanceId") or "").strip()
    otel = input_data.get("_otel") or {}
    if not app_id or not instance_id:
        raise RuntimeError("poll_session_workflow_status requires agentAppId + instanceId")
    attrs = {"agent.app_id": app_id, "agent.instance_id": instance_id, "agent.operation": "poll"}
    with start_activity_span("activity.poll_session_workflow_status", otel, attrs):
        status, body = _bff_post(
            "/api/internal/agent-runtime/status",
            {"agentAppId": app_id, "instanceId": instance_id},
            timeout=30,
        )
        if status == 200 and isinstance(body, dict):
            out = {
                "complete": bool(body.get("complete")),
                "runtimeStatus": str(body.get("runtimeStatus") or "UNKNOWN"),
                "output": body.get("output"),
                "missing": bool(body.get("missing")),
            }
            set_current_span_attrs(
                io_attributes("output", {"runtimeStatus": out["runtimeStatus"], "complete": out["complete"]})
            )
            return out
        # BFF unreachable / error — keep polling.
        return {"complete": False, "runtimeStatus": "UNKNOWN", "output": None, "missing": False}


def terminate_session_workflow(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Terminate a per-session ``session_workflow`` via the BFF (parent cancel /
    timeout, so the child stops + becomes purgeable). Best-effort."""
    app_id = str(input_data.get("agentAppId") or "").strip()
    instance_id = str(input_data.get("instanceId") or "").strip()
    reason = str(input_data.get("reason") or "workflow cancelled")
    otel = input_data.get("_otel") or {}
    if not app_id or not instance_id:
        return {"ok": False, "error": "missing agentAppId/instanceId"}
    attrs = {"agent.app_id": app_id, "agent.instance_id": instance_id, "agent.operation": "terminate"}
    with start_activity_span("activity.terminate_session_workflow", otel, attrs):
        status, body = _bff_post(
            "/api/internal/agent-runtime/terminate",
            {"agentAppId": app_id, "instanceId": instance_id, "reason": reason},
            timeout=30,
        )
        return {"ok": bool(body.get("ok")) if status == 200 else False, "status": status}
