from __future__ import annotations

import json
import logging
import os
import socket
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)

PUBLISH_ENABLED = os.environ.get("ENABLE_WORKFLOW_EVENTS", "true").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
WORKFLOW_BUILDER_URL = os.environ.get(
    "WORKFLOW_BUILDER_URL", "http://workflow-builder.nextjs.svc.cluster.local:3000"
).rstrip("/")
INTERNAL_API_TOKEN = os.environ.get("INTERNAL_API_TOKEN", "")

_PRODUCER_ID = (
    os.environ.get("AGENT_SLUG")
    or os.environ.get("WORKFLOW_BUILDER_APP_ID")
    or socket.gethostname()
    or "claude-agent-py"
)
_PRODUCER_EPOCH = str(time.time_ns())
_PRODUCER_SEQ_LOCK = threading.Lock()
_PRODUCER_SEQ = 0

_CMA_EVENT_TYPE_MAP: dict[str, str] = {
    "llm_complete": "agent.message",
    "tool_call_start": "agent.tool_use",
    "tool_call_end": "agent.tool_result",
    "tool_call_error": "agent.tool_result",
}
_SESSION_SUPPRESSED_TYPES = {"run_started", "run_complete", "run_error"}


def _next_source_event_id() -> str:
    global _PRODUCER_SEQ
    with _PRODUCER_SEQ_LOCK:
        _PRODUCER_SEQ += 1
        seq = _PRODUCER_SEQ
    return f"{_PRODUCER_ID}:{_PRODUCER_EPOCH}:{seq}"


def _cma_shape(event_type: str, data: dict[str, Any] | None) -> tuple[str | None, dict[str, Any]]:
    payload = dict(data or {})
    if event_type in _SESSION_SUPPRESSED_TYPES:
        return None, payload
    cma_type = _CMA_EVENT_TYPE_MAP.get(event_type, event_type)
    payload["_internalType"] = event_type

    if event_type == "llm_complete":
        content = payload.pop("content", "") or ""
        payload["content"] = [{"type": "text", "text": str(content)}]
    elif event_type == "tool_call_start":
        payload["name"] = payload.pop("toolName", None) or payload.get("name")
        payload["input"] = payload.pop("args", None) or payload.get("input") or {}
    elif event_type in {"tool_call_end", "tool_call_error"}:
        payload["tool_name"] = payload.pop("toolName", None) or payload.get("tool_name")
        payload.setdefault("success", event_type == "tool_call_end")
        if event_type == "tool_call_error":
            payload.setdefault("is_error", True)
    return cma_type, payload


def _post_ingest(session_id: str, envelope: dict[str, Any]) -> None:
    if not INTERNAL_API_TOKEN:
        logger.info(
            "[session-ingest] skipping %s %s - INTERNAL_API_TOKEN unset",
            session_id,
            envelope.get("type"),
        )
        return
    try:
        import urllib.request

        request = urllib.request.Request(
            f"{WORKFLOW_BUILDER_URL}/api/internal/sessions/{session_id}/events/ingest",
            data=json.dumps(envelope).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {INTERNAL_API_TOKEN}",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            logger.info(
                "[session-ingest] %s %s -> HTTP %d",
                session_id,
                envelope.get("type"),
                response.status,
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
) -> None:
    if not PUBLISH_ENABLED or not session_id:
        return

    cma_type, cma_data = _cma_shape(event_type, data)
    if cma_type is None:
        return
    envelope = {
        "type": cma_type,
        "data": cma_data,
        "sourceEventId": source_event_id or _next_source_event_id(),
        "producerId": _PRODUCER_ID,
        "producerEpoch": _PRODUCER_EPOCH,
    }
    threading.Thread(target=_post_ingest, args=(session_id, envelope), daemon=True).start()
