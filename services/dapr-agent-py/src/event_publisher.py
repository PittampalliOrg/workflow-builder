"""
Non-blocking event publisher for agent activity streaming.

Publishes agent execution events to workflow.stream via Dapr pub/sub.
The workflow-builder's agent-stream handler bridges events to per-execution
NATS subjects for SSE consumers.

Publishing is fire-and-forget via daemon threads — never blocks the agent workflow.
Transient errors (5xx, timeouts) trigger exponential backoff; permanent errors (4xx)
disable publishing.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

DAPR_HOST = os.environ.get("DAPR_HOST", "127.0.0.1")
DAPR_HTTP_PORT = os.environ.get("DAPR_HTTP_PORT", "3500")
PUBSUB_NAME = os.environ.get("PUBSUB_NAME", "pubsub")
PUBSUB_TOPIC = os.environ.get("WORKFLOW_EVENT_TOPIC", "workflow.stream")
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

# Callback installed by main.py after the agent is constructed. Signature:
#     (event_type: str, data: dict, execution_id: str | None, instance_id: str | None) -> None
# The callback is responsible for its own error handling. Always invoked on
# a daemon thread so it can use asyncio freely.
_notification_dispatcher = None


def set_notification_dispatcher(fn) -> None:
    """Register a callable that receives eligible events as Notification hooks.

    Safe to call multiple times — later calls override earlier ones.
    """
    global _notification_dispatcher
    _notification_dispatcher = fn

_publish_url = f"http://{DAPR_HOST}:{DAPR_HTTP_PORT}/v1.0/publish/{PUBSUB_NAME}/{PUBSUB_TOPIC}"

# Transient error tracking — exponential backoff, not permanent disable
_consecutive_failures = 0
_cooldown_until = 0.0  # epoch timestamp
_permanently_disabled = False
_MAX_CONSECUTIVE_FAILURES = 5
_COOLDOWN_SECONDS = 30


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _do_publish(payload: bytes) -> None:
    """Synchronous HTTP publish — runs in a daemon thread."""
    global _consecutive_failures, _cooldown_until, _permanently_disabled

    if _permanently_disabled:
        return

    # Check cooldown
    if time.monotonic() < _cooldown_until:
        return

    try:
        import urllib.request

        req = urllib.request.Request(
            _publish_url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            status = resp.status
            if status >= 400 and status < 500:
                # Permanent error (4xx) — topic doesn't exist, auth failure, etc.
                _permanently_disabled = True
                logger.warning("[events] Permanently disabled: HTTP %d", status)
                return
            if status >= 500:
                # Transient server error
                raise Exception(f"HTTP {status}")

        # Success — reset failure counter
        _consecutive_failures = 0

    except Exception as exc:
        _consecutive_failures += 1
        if _consecutive_failures >= _MAX_CONSECUTIVE_FAILURES:
            _cooldown_until = time.monotonic() + _COOLDOWN_SECONDS
            logger.info(
                "[events] %d consecutive failures, cooling down %ds: %s",
                _consecutive_failures,
                _COOLDOWN_SECONDS,
                exc,
            )
            _consecutive_failures = 0  # Reset after cooldown set


_WORKFLOW_BUILDER_URL = os.environ.get(
    "WORKFLOW_BUILDER_URL", "http://workflow-builder.nextjs.svc.cluster.local:3000"
)
_INTERNAL_API_TOKEN = os.environ.get("INTERNAL_API_TOKEN", "")


def _post_ingest(session_id: str, envelope: dict[str, Any]) -> None:
    """Non-blocking POST of a session event to the SvelteKit BFF's internal
    ingest endpoint. The BFF assigns the sequence number and writes to
    `session_events`. Swallows all errors — NATS remains the primary transport;
    the DB write is durability + replay.
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
    session_id: str,
    event_type: str,
    data: dict[str, Any] | None = None,
    *,
    source_event_id: str | None = None,
) -> None:
    """Emit a CMA-shape session event. Dual-write:
    1. NATS pub/sub (fire-and-forget, drives the SSE live stream).
    2. Internal ingest endpoint (durable + replay; assigns sequence numbers).

    Both are best-effort and non-blocking. See
    `shared/managed-agents-events.md` for the event-type taxonomy.
    """
    if not PUBLISH_ENABLED:
        return

    envelope_inner = {
        "type": event_type,
        "data": data or {},
        "sourceEventId": source_event_id,
    }

    # 1. NATS via workflow.stream (existing infrastructure picks up the
    #    `sessionId` field and routes to session.events.<sessionId>).
    publish_event(
        event_type,
        {**(data or {}), "_sessionId": session_id},
        execution_id=session_id,  # reuse for correlation
        instance_id=session_id,
        source_event_id=source_event_id,
    )

    # 2. Postgres ingest on a daemon thread (non-blocking).
    threading.Thread(
        target=_post_ingest,
        args=(session_id, envelope_inner),
        daemon=True,
    ).start()


def publish_event(
    event_type: str,
    data: dict[str, Any] | None = None,
    *,
    execution_id: str | None = None,
    instance_id: str | None = None,
    source_event_id: str | None = None,
) -> None:
    """Publish an agent event to Dapr pub/sub (fire-and-forget, non-blocking)."""
    if not PUBLISH_ENABLED or _permanently_disabled:
        return

    payload = json.dumps(
        {
            "source": "dapr-agent-py",
            "type": event_type,
            "executionId": execution_id or None,
            "instanceId": instance_id or None,
            "sourceEventId": source_event_id or None,
            "data": data or {},
            "timestamp": _now_iso(),
        }
    ).encode()

    # Fire-and-forget in daemon thread — never blocks the agent workflow
    threading.Thread(target=_do_publish, args=(payload,), daemon=True).start()

    # Fire Notification hooks for eligible event types. Isolated daemon
    # thread so hook subprocess spawning never impacts the event publish.
    dispatcher = _notification_dispatcher
    if dispatcher is not None and event_type in _NOTIFICATION_EVENT_TYPES:
        def _fire_notification():
            try:
                dispatcher(event_type, data or {}, execution_id, instance_id)
            except Exception as exc:
                logger.debug("[notification-hook] dispatch failed: %s", exc)

        threading.Thread(target=_fire_notification, daemon=True).start()


def publish_workflow_started(
    execution_id: str,
    instance_id: str,
    task: str | None = None,
    model: str | None = None,
) -> None:
    publish_event(
        "run_started",
        {
            "task": (task or "")[:500],
            "model": model,
        },
        execution_id=execution_id,
        instance_id=instance_id,
    )


def publish_tool_start(
    execution_id: str,
    instance_id: str,
    tool_name: str,
    tool_args: dict[str, Any] | None = None,
    source_event_id: str | None = None,
) -> None:
    publish_event(
        "tool_call_start",
        {
            "toolName": tool_name,
            "args": {k: str(v)[:200] for k, v in (tool_args or {}).items()},
        },
        execution_id=execution_id,
        instance_id=instance_id,
        source_event_id=source_event_id,
    )


def publish_tool_complete(
    execution_id: str,
    instance_id: str,
    tool_name: str,
    success: bool = True,
    error: str | None = None,
    output: str | None = None,
    checkpoint: dict[str, Any] | None = None,
    source_event_id: str | None = None,
) -> None:
    payload = {
        "toolName": tool_name,
        "success": success,
        "error": error,
        "output": (output or "")[:500],
    }
    if checkpoint is not None:
        payload["codeCheckpoint"] = checkpoint
    publish_event(
        "tool_call_end" if success else "tool_call_error",
        payload,
        execution_id=execution_id,
        instance_id=instance_id,
        source_event_id=source_event_id,
    )


def publish_llm_start(
    execution_id: str,
    instance_id: str,
    model: str | None = None,
) -> None:
    publish_event(
        "llm_start",
        {"model": model},
        execution_id=execution_id,
        instance_id=instance_id,
    )


def publish_llm_complete(
    execution_id: str,
    instance_id: str,
    content: str | None = None,
    tool_calls: list[str] | None = None,
) -> None:
    publish_event(
        "llm_complete",
        {
            "content": (content or "")[:500],
            "toolCalls": tool_calls or [],
        },
        execution_id=execution_id,
        instance_id=instance_id,
    )


def publish_compaction_start(
    execution_id: str,
    instance_id: str,
    pre_count: int,
    threshold: int,
    trigger: str = "auto",
) -> None:
    publish_event(
        "compaction_start",
        {
            "preCount": pre_count,
            "threshold": threshold,
            "trigger": trigger,
        },
        execution_id=execution_id,
        instance_id=instance_id,
    )


def publish_compaction_complete(
    execution_id: str,
    instance_id: str,
    *,
    pre_count: int,
    post_count: int,
    messages_dropped: int,
    messages_preserved: int,
    ptl_retries: int = 0,
    trigger: str = "auto",
    reason: str = "",
    success: bool = True,
    error: str | None = None,
) -> None:
    publish_event(
        "compaction_complete" if success else "compaction_error",
        {
            "preCount": pre_count,
            "postCount": post_count,
            "messagesDropped": messages_dropped,
            "messagesPreserved": messages_preserved,
            "ptlRetries": ptl_retries,
            "trigger": trigger,
            "reason": reason,
            "success": success,
            "error": error,
        },
        execution_id=execution_id,
        instance_id=instance_id,
    )


def publish_workflow_completed(
    execution_id: str,
    instance_id: str,
    success: bool = True,
    error: str | None = None,
    output: str | None = None,
) -> None:
    publish_event(
        "run_complete" if success else "run_error",
        {
            "success": success,
            "error": error,
            "output": (output or "")[:500],
        },
        execution_id=execution_id,
        instance_id=instance_id,
    )
