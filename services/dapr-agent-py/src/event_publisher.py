"""
Session event publisher.

Phase 4 Step 2b: session_events is the single authoritative event stream
for agent activity. The legacy `workflow.stream` Dapr pub/sub topic and the
`workflow_agent_events` dual-write path are gone; callers POST directly to
the SvelteKit BFF's internal ingest endpoint. Publishing is fire-and-forget
via daemon threads — never blocks the agent workflow.

CMA-shape translation happens here so call sites can keep passing internal
names like `llm_complete` / `tool_call_start` / `tool_call_end`; the ingest
endpoint receives the CMA shape the /sessions/[id] UI expects.
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import threading
from typing import Any

logger = logging.getLogger(__name__)


# Per-call session scope. main.py's call_llm sets this before delegating into
# the Dapr chat client (which is monkey-patched by anthropic_adapter). The
# adapter reads it to emit agent.thinking events without needing to plumb
# session_id through the DaprChatClient.generate signature.
_session_scope = contextvars.ContextVar[tuple[str | None, str | None]](
    "session_scope", default=(None, None)
)


def scope_session(session_id: str | None, instance_id: str | None):
    """Push a session_id/instance_id scope for the current task. Returns a
    Token that must be passed back to `unscope_session` in a finally block.
    """
    return _session_scope.set((session_id, instance_id))


def unscope_session(token) -> None:
    try:
        _session_scope.reset(token)
    except Exception:
        pass


def get_scoped_session() -> tuple[str | None, str | None]:
    """Returns (session_id, instance_id) for the active call, or (None, None)."""
    return _session_scope.get()

PUBLISH_ENABLED = os.environ.get("ENABLE_WORKFLOW_EVENTS", "true").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

# Event types that should also fire a Notification hook. Kept small on purpose
# — Notification hooks are user-visible, so we only fire them for events that
# represent something a user would want to be alerted about.
_NOTIFICATION_EVENT_TYPES: set[str] = {
    "tool_call_error",
    "run_error",
    "ask_user_prompt",
}

# Types session_workflow already emits as session.status_* events — suppress
# the redundant agent-side variant to keep the session stream clean.
_SESSION_SUPPRESSED_TYPES: set[str] = {
    "run_started",
    "run_complete",
    "run_error",
}

# Translate internal agent event types to the CMA shape the /sessions/[id] UI
# expects. Types not in this map pass through unchanged (llm_start,
# state_snapshot, plan_artifact, compaction_*). The original type is stashed
# in data._internalType for debugging.
_CMA_EVENT_TYPE_MAP: dict[str, str] = {
    "llm_complete": "agent.message",
    "tool_call_start": "agent.tool_use",
    "tool_call_end": "agent.tool_result",
    "tool_call_error": "agent.tool_result",
}


def _cma_shape(
    event_type: str, data: dict[str, Any] | None
) -> tuple[str | None, dict[str, Any]]:
    """Translate (type, data) to CMA shape for the session event stream.
    Returns (new_type, new_data). new_type is None if the event should be
    suppressed from the session stream.
    """
    payload = dict(data or {})
    if event_type in _SESSION_SUPPRESSED_TYPES:
        return None, payload

    cma_type = _CMA_EVENT_TYPE_MAP.get(event_type, event_type)
    payload["_internalType"] = event_type

    if event_type == "llm_complete":
        content = payload.pop("content", "") or ""
        if isinstance(content, str):
            # CMA shape: `content` is an array of typed blocks. Full text
            # lives here; `preview` (if set by the caller) is kept as a
            # separate field so the row-view can summarize without re-walking
            # the content array.
            payload["content"] = [{"type": "text", "text": content}]
        # `preview` / `oversized` / `size_bytes` pass through as-is.
    elif event_type == "tool_call_start":
        payload["name"] = payload.pop("toolName", None) or payload.get("name")
        payload["input"] = payload.pop("args", None) or payload.get("input") or {}
        # `input_preview` / `oversized` / `size_bytes` pass through as-is.
    elif event_type in ("tool_call_end", "tool_call_error"):
        payload["tool_name"] = payload.pop("toolName", None) or payload.get("tool_name")
        output = payload.pop("output", None)
        if output is not None:
            payload["output"] = output
        error = payload.pop("error", None)
        if error:
            payload["error"] = error
            payload.setdefault("is_error", True)
        # `output_preview` / `oversized` / `size_bytes` pass through as-is.
    return cma_type, payload


# Callback installed by main.py after the agent is constructed. Signature:
#     (event_type: str, data: dict, session_id: str | None, instance_id: str | None) -> None
# Always invoked on a daemon thread so it can use asyncio freely.
_notification_dispatcher = None


def set_notification_dispatcher(fn) -> None:
    """Register a callable that receives eligible events as Notification hooks.

    Safe to call multiple times — later calls override earlier ones.
    """
    global _notification_dispatcher
    _notification_dispatcher = fn


_WORKFLOW_BUILDER_URL = os.environ.get(
    "WORKFLOW_BUILDER_URL", "http://workflow-builder.nextjs.svc.cluster.local:3000"
)
_INTERNAL_API_TOKEN = os.environ.get("INTERNAL_API_TOKEN", "")


def _post_ingest(session_id: str, envelope: dict[str, Any]) -> None:
    """Non-blocking POST of a session event to the SvelteKit BFF's internal
    ingest endpoint. The BFF assigns the sequence number and writes to
    `session_events`.
    """
    if not _INTERNAL_API_TOKEN:
        logger.info(
            "[session-ingest] skipping %s %s — INTERNAL_API_TOKEN unset",
            session_id,
            envelope.get("type"),
        )
        return
    try:
        import urllib.request

        url = f"{_WORKFLOW_BUILDER_URL}/api/internal/sessions/{session_id}/events/ingest"
        req = urllib.request.Request(
            url,
            data=json.dumps(envelope).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {_INTERNAL_API_TOKEN}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            logger.info(
                "[session-ingest] %s %s -> HTTP %d",
                session_id,
                envelope.get("type"),
                resp.status,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[session-ingest] POST failed %s %s: %s",
            session_id,
            envelope.get("type"),
            exc,
        )


def publish_session_event(
    session_id: str | None,
    event_type: str,
    data: dict[str, Any] | None = None,
    *,
    source_event_id: str | None = None,
    instance_id: str | None = None,
) -> None:
    """Emit a session event. CMA-shape translation is applied for legacy
    internal types; notification hooks fire for a small set of user-visible
    types on a daemon thread. Callers pass internal type names
    (`llm_complete`, `tool_call_start`, ...) — this function maps them to
    CMA (`agent.message`, `agent.tool_use`, ...) before posting.

    `instance_id` is only used to thread context to Notification hooks and
    does not affect routing; when omitted, `session_id` is passed instead.
    """
    if not PUBLISH_ENABLED:
        return
    if not session_id:
        logger.debug("[session-ingest] skipping %s — no session_id in scope", event_type)
        return

    # Fire Notification hooks for eligible event types on the pre-translation
    # name, matching Claude Code's hook matcher vocabulary.
    dispatcher = _notification_dispatcher
    if dispatcher is not None and event_type in _NOTIFICATION_EVENT_TYPES:
        def _fire_notification():
            try:
                dispatcher(event_type, data or {}, session_id, instance_id or session_id)
            except Exception as exc:  # noqa: BLE001
                logger.debug("[notification-hook] dispatch failed: %s", exc)

        threading.Thread(target=_fire_notification, daemon=True).start()

    cma_type, cma_data = _cma_shape(event_type, data)
    if cma_type is None:
        return  # suppressed — session_workflow emits the canonical equivalent

    # Stamp trace_id + span_id of the currently-active OTEL span onto the
    # envelope so the UI can deep-link any event row into Phoenix / ClickHouse
    # without needing a separate correlation step. Best-effort — if the OTEL
    # provider isn't initialized or there's no recording span (likely during
    # Dapr workflow replay), we skip silently.
    try:
        from src.telemetry.session_tracing import get_current_trace_context

        trace_id, span_id = get_current_trace_context()
        if trace_id:
            cma_data.setdefault("traceId", trace_id)
        if span_id:
            cma_data.setdefault("spanId", span_id)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[session-ingest] trace-context stamp failed: %s", exc)

    envelope = {
        "type": cma_type,
        "data": cma_data,
        "sourceEventId": source_event_id,
    }
    threading.Thread(
        target=_post_ingest, args=(session_id, envelope), daemon=True
    ).start()
