"""Session event publisher (canonical, shared across durable-agent runtimes).

CANONICAL SOURCE: ``services/shared/session_events/publisher.py`` — do NOT edit
the vendored per-service copies (``services/dapr-agent-py/src/event_publisher.py``
and ``services/claude-agent-py/src/event_publisher.py``). Edit this file, then run
``node scripts/sync-runtime-registry.mjs`` to regenerate the byte-identical copies.
Each Python service's Docker build context is its own subdir and cannot COPY this
shared file directly, so the copies are vendored in-tree; a vitest drift guard
(``src/lib/server/agents/shared-publisher.test.ts``) and the sync ``--check`` mode
assert the copies match this canonical.

``session_events`` is the single authoritative event stream for agent activity.
The legacy ``workflow.stream`` Dapr pub/sub topic and the ``workflow_agent_events``
dual-write path are gone; callers POST directly to the SvelteKit BFF's internal
ingest endpoint. Publishing is fire-and-forget via daemon threads — never blocks
the agent workflow.

CMA-shape translation happens here so call sites can keep passing internal names
like ``llm_complete`` / ``tool_call_start`` / ``tool_call_end``; the ingest endpoint
receives the CMA shape the /sessions/[id] UI expects.

INCREMENTAL TIER (registry capability ``incrementalEvents``): notification-hook
dispatch, audit-field stamping, ``agent.llm_usage`` context telemetry, and OTEL
trace-context stamping are gated behind ``INCREMENTAL_EVENTS_ENABLED`` (default
OFF). A runtime whose registry descriptor declares ``incrementalEvents: true``
(dapr-agent-py / dapr-agent-py-testing) opts in once at startup via
``set_incremental_tier_enabled(True)``. That tier imports runtime-internal modules
(``src.compaction.tokens``, ``src.telemetry.session_tracing``) that simpler
runtimes (claude-agent-py / adk-agent-py — ``incrementalEvents: false``) do not
ship, so the gate keeps this byte-identical copy inert (no per-event import
failures) on those runtimes. The base path — producer-identity dedup, CMA-shape
translation, fire-and-forget POST — is identical on every runtime.
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import socket
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------
# Incremental tier gate (registry capability `incrementalEvents`)
# ---------------------------------------------------------------------------
#
# OFF by default so the byte-identical vendored copy is inert on runtimes that
# don't ship the runtime-internal telemetry modules. dapr-agent-py opts in at
# startup (set_incremental_tier_enabled(True)); SESSION_EVENTS_INCREMENTAL is an
# ops escape hatch (env override consulted at import).
INCREMENTAL_EVENTS_ENABLED = _env_bool("SESSION_EVENTS_INCREMENTAL", False)


def set_incremental_tier_enabled(enabled: bool) -> None:
    """Enable/disable the incremental enrichment tier (notification hooks,
    audit-field stamping, ``agent.llm_usage`` telemetry, OTEL trace-context).

    Called once at startup by runtimes whose registry descriptor declares
    ``incrementalEvents: true``. Mutates the module global read at publish time,
    so it must run before the first ``publish_session_event`` (well before any
    workflow executes — safe in practice).
    """
    global INCREMENTAL_EVENTS_ENABLED
    INCREMENTAL_EVENTS_ENABLED = bool(enabled)


# ---------------------------------------------------------------------------
# Producer identity (durable-streams (Producer-Id, Producer-Epoch, Producer-Seq))
# ---------------------------------------------------------------------------
#
# Every envelope carries these so:
#   1. The (session_id, source_event_id) UNIQUE constraint on session_events
#      dedupes daemon-thread retries + stale-pod writes universally — not just
#      the 6/24 call sites that pass a domain-meaningful source_event_id today.
#   2. producer_id joins with agents.slug so "events by agent X" is a one-
#      liner query (CMA-aligned identity, stable across pod restarts).
#
# Producer-Id = agent slug (AGENT_SLUG env var stamped by the BFF on the
#   SandboxTemplate / per-session Sandbox spec for warm-pool and Kueue-
#   admitted pods; falls back to WORKFLOW_BUILDER_APP_ID for the legacy
#   shared dapr-agent-py pod; finally hostname as a last resort).
# Producer-Epoch = pod process start-time in ns — monotonic across restarts,
#   collision-free in practice (pods don't restart at nanosecond resolution).
# Producer-Seq = in-process atomic counter, unique per (id, epoch).
_PRODUCER_ID = (
    os.environ.get("AGENT_SLUG")
    or os.environ.get("WORKFLOW_BUILDER_APP_ID")
    or socket.gethostname()
    or "unknown"
)
_PRODUCER_EPOCH = str(time.time_ns())
_PRODUCER_SEQ_LOCK = threading.Lock()
_PRODUCER_SEQ = 0


def _next_producer_seq() -> int:
    global _PRODUCER_SEQ
    with _PRODUCER_SEQ_LOCK:
        _PRODUCER_SEQ += 1
        return _PRODUCER_SEQ


def _default_source_event_id() -> str:
    """Return a unique {producer_id}:{producer_epoch}:{producer_seq} triple.
    Called as the default when a caller does not supply a
    domain-meaningful source_event_id — the 6 existing callers that pass
    tool_call_id-derived values keep theirs unchanged."""
    return f"{_PRODUCER_ID}:{_PRODUCER_EPOCH}:{_next_producer_seq()}"


# Per-call session scope. main.py's call_llm sets this before delegating into
# the Dapr chat client (which is monkey-patched by anthropic_adapter). The
# adapter reads it to emit agent.thinking events without needing to plumb
# session_id through the DaprChatClient.generate signature.
_session_scope = contextvars.ContextVar[tuple[str | None, str | None]](
    "session_scope", default=(None, None)
)
_audit_scope = contextvars.ContextVar[dict[str, Any]](
    "session_audit_scope", default={}
)


def scope_session(
    session_id: str | None,
    instance_id: str | None,
    audit_fields: dict[str, Any] | None = None,
):
    """Push a session_id/instance_id scope for the current task. Returns a
    Token that must be passed back to `unscope_session` in a finally block.
    """
    session_token = _session_scope.set((session_id, instance_id))
    audit_token = _audit_scope.set(dict(audit_fields or {}))
    return session_token, audit_token


def unscope_session(token) -> None:
    try:
        if isinstance(token, tuple) and len(token) == 2:
            _session_scope.reset(token[0])
            _audit_scope.reset(token[1])
        else:
            _session_scope.reset(token)
    except Exception:
        pass


def get_scoped_session() -> tuple[str | None, str | None]:
    """Returns (session_id, instance_id) for the active call, or (None, None)."""
    return _session_scope.get()


def get_scoped_audit_fields() -> dict[str, Any]:
    return dict(_audit_scope.get() or {})

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


def _tool_output_error(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict):
        raw = value.get("error")
        return str(raw).strip() if raw else None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.lower().startswith("error:"):
            return text[:1000]
        if text.startswith("{"):
            try:
                parsed = json.loads(text)
            except (TypeError, ValueError):
                return None
            if isinstance(parsed, dict):
                raw = parsed.get("error")
                return str(raw).strip() if raw else None
    return None


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
    if event_type != "session.runtime_config":
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
        if not error:
            error = _tool_output_error(output)
        if error:
            payload["error"] = error
            payload.setdefault("is_error", True)
            payload["success"] = False
        elif event_type == "tool_call_error":
            payload["success"] = False
        else:
            payload.setdefault("success", True)
        # `output_preview` / `oversized` / `size_bytes` pass through as-is.
    return cma_type, payload


# Callback installed by main.py after the agent is constructed. Signature:
#     (event_type: str, data: dict, session_id: str | None, instance_id: str | None) -> None
# Always invoked on a daemon thread so it can use asyncio freely. Only consulted
# when the incremental tier is enabled (set_incremental_tier_enabled).
_notification_dispatcher = None
_audit_field_provider = None


def set_notification_dispatcher(fn) -> None:
    """Register a callable that receives eligible events as Notification hooks.

    Safe to call multiple times — later calls override earlier ones.
    """
    global _notification_dispatcher
    _notification_dispatcher = fn


def set_audit_field_provider(fn) -> None:
    """Register a callable that returns audit fields for a workflow instance."""
    global _audit_field_provider
    _audit_field_provider = fn


def _effective_audit_fields(instance_id: str | None) -> dict[str, Any]:
    fields = get_scoped_audit_fields()
    if fields:
        return fields
    provider = _audit_field_provider
    if provider is None or not instance_id:
        return {}
    try:
        result = provider(instance_id)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[session-ingest] audit-field provider failed: %s", exc)
        return {}
    return dict(result or {}) if isinstance(result, dict) else {}


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
    blocking: bool = False,
) -> None:
    """Emit a session event. CMA-shape translation is applied for legacy
    internal types; notification hooks fire for a small set of user-visible
    types on a daemon thread. Callers pass internal type names
    (`llm_complete`, `tool_call_start`, ...) — this function maps them to
    CMA (`agent.message`, `agent.tool_use`, ...) before posting.

    `instance_id` is only used to thread context to Notification hooks and
    does not affect routing; when omitted, `session_id` is passed instead.

    The notification-hook dispatch + audit/usage/trace enrichment are part of
    the incremental tier (gated on INCREMENTAL_EVENTS_ENABLED); the base path
    (CMA shape + producer-identity envelope + POST) always runs. Lifecycle
    callers can set blocking=True when database sequence ordering matters.
    """
    if not PUBLISH_ENABLED:
        return
    if not session_id:
        logger.debug("[session-ingest] skipping %s — no session_id in scope", event_type)
        return

    # Incremental tier — fire Notification hooks for eligible event types on the
    # pre-translation name, matching Claude Code's hook matcher vocabulary.
    if INCREMENTAL_EVENTS_ENABLED:
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

    # Incremental tier — audit fields, llm_usage context telemetry, and OTEL
    # trace-context stamping. Imports runtime-internal modules
    # (src.compaction.tokens, src.telemetry.session_tracing) only here, so the
    # gate keeps this inert on runtimes that don't ship them.
    if INCREMENTAL_EVENTS_ENABLED:
        for key, value in _effective_audit_fields(instance_id).items():
            if cma_type != "session.runtime_config" and value is not None:
                cma_data.setdefault(key, value)

        if cma_type == "agent.llm_usage":
            try:
                from src.compaction.tokens import context_usage_fields

                model = (
                    cma_data.get("model")
                    or cma_data.get("providerModel")
                    or cma_data.get("modelSpec")
                    or cma_data.get("llmComponent")
                )
                fields = context_usage_fields(
                    model=str(model) if model else None,
                    input_tokens=cma_data.get("input_tokens") or cma_data.get("prompt_tokens"),
                    cache_read_input_tokens=cma_data.get("cache_read_input_tokens"),
                    cache_creation_input_tokens=cma_data.get("cache_creation_input_tokens"),
                )
                cma_data.setdefault("context_source", "provider_usage")
                cma_data.setdefault("context_count_method", "provider_usage")
                cma_data.setdefault("context_count_scope", "last_provider_call")
                for key, value in fields.items():
                    cma_data.setdefault(key, value)
            except Exception as exc:  # noqa: BLE001
                logger.debug("[session-ingest] context telemetry stamp failed: %s", exc)

        # Stamp trace_id + span_id of the currently-active OTEL span onto the
        # envelope so the UI can deep-link any event row into Phoenix / ClickHouse
        # without needing a separate correlation step. Best-effort — if the OTEL
        # provider isn't initialized or there's no recording span (likely during
        # Dapr workflow replay), we skip silently.
        try:
            from src.telemetry.session_tracing import get_current_trace_context

            if cma_type != "session.runtime_config":
                trace_id, span_id = get_current_trace_context()
                if trace_id:
                    cma_data.setdefault("traceId", trace_id)
                if span_id:
                    cma_data.setdefault("spanId", span_id)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[session-ingest] trace-context stamp failed: %s", exc)

    # Fill in source_event_id when the caller did not supply a
    # domain-meaningful one. The triple is unique across this pod's lifetime
    # and, because the Producer-Id component is the agent slug (or fallback),
    # unique cluster-wide when combined with the per-pod epoch. Unique
    # constraint uq_session_events_source (partial, source_event_id NOT NULL)
    # then dedupes every event on the ingest path.
    effective_source = source_event_id or _default_source_event_id()
    envelope = {
        "type": cma_type,
        "data": cma_data,
        "sourceEventId": effective_source,
        "producerId": _PRODUCER_ID,
        "producerEpoch": _PRODUCER_EPOCH,
    }
    if blocking:
        _post_ingest(session_id, envelope)
        return
    threading.Thread(
        target=_post_ingest, args=(session_id, envelope), daemon=True
    ).start()
