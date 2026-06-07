"""Fire-and-poll dispatch for cross-app-id ``durable/run`` child session workflows.

These activities let the SW-interpreter parent START a per-session agent
``session_workflow`` on a DIFFERENT Dapr app-id (a separate task hub) and POLL
its status/output — WITHOUT holding an outstanding cross-app sub-orchestration.

Why: a parent blocked in ``ctx.call_child_workflow(app_id=<agent>)`` cannot be
terminated — Dapr's terminate does not apply to a parent awaiting a
sub-orchestration on another task hub, so a user Stop hangs the run forever (and
a cooperative ``when_any`` early-return hot-loops because the dangling cross-app
task can't be reconciled once the child self-completes/purges). Fire-and-poll
keeps the parent's durable history same-task-hub (only timers + activities + one
external-event subscription), so a user Stop is observed at the next poll
boundary and the parent unwinds to a clean terminal state. See
docs/workflow-lifecycle-termination.md.

The child agent ``session_workflow`` reaches a terminal Dapr status but does NOT
self-purge (held by the 168h ``stateRetentionPolicy``), so the poll reads its
real serialized output with no purge race. Endpoints mirror what the BFF uses for
direct sessions / lifecycle control (``/internal/sessions/spawn``,
``GET /api/v2/agent-runs/{id}/status``, ``POST .../terminate``).
"""
from __future__ import annotations

from typing import Any

from content_tracing import io_attributes
from tracing import set_current_span_attrs, start_activity_span

from .dapr_invoke import dapr_invoke

_TERMINAL_RUNTIME_STATUSES = {"COMPLETED", "FAILED", "TERMINATED"}


def _looks_missing(status: int, text: str) -> bool:
    """True when the agent runtime reports the instance is gone (purged / never
    started). dapr_invoke collapses the SDK's non-2xx into (500, …, text), so we
    also sniff the error text — same spirit as the BFF's benign-miss check."""
    t = (text or "").lower()
    return status == 404 or "404" in t or "not found" in t or "not_found" in t


def start_session_workflow(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Fire-and-forget start of a per-session ``session_workflow`` on the agent
    app-id. Idempotent: the agent's ``/internal/sessions/spawn`` reuses an
    existing instanceId (StartInstance ALREADY_EXISTS is swallowed), so a Dapr
    activity retry / parent replay is safe."""
    app_id = str(input_data.get("agentAppId") or "").strip()
    instance_id = str(input_data.get("instanceId") or "").strip()
    payload = input_data.get("payload") if isinstance(input_data.get("payload"), dict) else {}
    otel = input_data.get("_otel") or {}
    if not app_id or not instance_id:
        raise RuntimeError("start_session_workflow requires agentAppId + instanceId")
    attrs = {"agent.app_id": app_id, "agent.instance_id": instance_id, "agent.operation": "start"}
    with start_activity_span("activity.start_session_workflow", otel, attrs):
        set_current_span_attrs(io_attributes("input", {"instanceId": instance_id, "agentAppId": app_id}))
        status, _body, text = dapr_invoke(
            app_id,
            "internal/sessions/spawn",
            {"instanceId": instance_id, "payload": payload},
            timeout=60,
        )
        if status >= 400:
            raise RuntimeError(f"start_session_workflow failed ({status}): {text[:300]}")
        result = {"ok": True, "instanceId": instance_id, "status": status}
        set_current_span_attrs(io_attributes("output", result))
        return result


def poll_session_workflow_status(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Poll a per-session ``session_workflow``'s runtime status + output on the
    agent app-id. NEVER raises — returns
    ``{complete, runtimeStatus, output, missing}``; transient (5xx/unknown)
    errors return ``complete=False`` so the parent's poll loop keeps trying."""
    app_id = str(input_data.get("agentAppId") or "").strip()
    instance_id = str(input_data.get("instanceId") or "").strip()
    otel = input_data.get("_otel") or {}
    if not app_id or not instance_id:
        raise RuntimeError("poll_session_workflow_status requires agentAppId + instanceId")
    attrs = {"agent.app_id": app_id, "agent.instance_id": instance_id, "agent.operation": "poll"}
    with start_activity_span("activity.poll_session_workflow_status", otel, attrs):
        # summary defaults to False on the agent endpoint -> full serialized output.
        status, body, text = dapr_invoke(
            app_id,
            f"api/v2/agent-runs/{instance_id}/status",
            {},
            timeout=30,
            http_verb="GET",
        )
        if status == 200 and isinstance(body, dict):
            runtime_status = str(body.get("runtimeStatus") or "").upper()
            complete = runtime_status in _TERMINAL_RUNTIME_STATUSES
            out = {
                "complete": complete,
                "runtimeStatus": runtime_status,
                "output": body.get("output"),
                "missing": False,
            }
            set_current_span_attrs(
                io_attributes("output", {"runtimeStatus": runtime_status, "complete": complete})
            )
            return out
        if _looks_missing(status, text):
            # Instance gone (purged / never started): stop polling, let the
            # parent reconcile from the DB (workflow_agent_runs.result).
            return {"complete": True, "runtimeStatus": "GONE", "output": None, "missing": True}
        # Transient — keep polling.
        return {
            "complete": False,
            "runtimeStatus": "UNKNOWN",
            "output": None,
            "missing": False,
            "error": (text or "")[:300],
        }


def terminate_session_workflow(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Terminate a per-session ``session_workflow`` on the agent app-id (used when
    the parent is cancelled or times out, so the child stops and becomes
    purgeable). Best-effort — a 404 (already gone) counts as success."""
    app_id = str(input_data.get("agentAppId") or "").strip()
    instance_id = str(input_data.get("instanceId") or "").strip()
    reason = str(input_data.get("reason") or "workflow cancelled")
    otel = input_data.get("_otel") or {}
    if not app_id or not instance_id:
        return {"ok": False, "error": "missing agentAppId/instanceId"}
    attrs = {"agent.app_id": app_id, "agent.instance_id": instance_id, "agent.operation": "terminate"}
    with start_activity_span("activity.terminate_session_workflow", otel, attrs):
        status, _body, text = dapr_invoke(
            app_id,
            f"api/v2/agent-runs/{instance_id}/terminate",
            {"reason": reason},
            timeout=30,
        )
        ok = status < 400 or _looks_missing(status, text)
        return {"ok": ok, "status": status}
