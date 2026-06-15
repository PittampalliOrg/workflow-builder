"""Idempotency cache for ``run_tool`` — at-least-once → effectively once.

``run_tool`` is dispatched as a Dapr activity with a retry policy
(``main.py``: ``ctx.call_activity(self.run_tool, ..., retry_policy=self._retry_policy)``)
and is NOT idempotent: a transient failure retries the SAME activity, and a pod
death after a tool's side effect but before the activity result is recorded
re-runs the body from the top — double-executing the side effect.

This records each tool result keyed on ``(instance_id, tool_call_id)`` and
short-circuits a replayed call so the side effect runs at most once. Two tiers:

  - **in-memory cache** — covers same-pod activity retries (the dominant case
    under the activity retry policy: the runtime re-schedules the failed
    activity and a healthy worker re-runs it);
  - **durable scan** (``find_recorded_tool_result``) — a pure scan of
    ``entry.messages`` for an already-recorded ToolMessage with the same
    ``tool_call_id``, mirroring the compaction ``__COMPACT_BOUNDARY__``
    durable-sentinel idempotency pattern for the cross-pod-replay case.

Only **successful** results are cached: a failed tool must remain retryable.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

# Soft cap so a multi-hour session with thousands of tool calls cannot grow the
# in-memory cache without bound. Oldest entries are evicted first (insertion
# order). The cache is per-session (per ephemeral pod) so this is generous.
DEFAULT_MAX_ENTRIES = 5000


def _max_entries() -> int:
    raw = os.environ.get("DAPR_AGENT_PY_TOOL_IDEMPOTENCY_MAX_ENTRIES")
    if raw and raw.strip():
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return DEFAULT_MAX_ENTRIES


def tool_idempotency_enabled() -> bool:
    raw = os.environ.get("DAPR_AGENT_PY_TOOL_IDEMPOTENCY_ENABLED")
    if raw is None:
        return True
    return raw.strip().lower() in ("1", "true", "yes", "on")


class ToolResultCache:
    """In-memory ``(instance_id, tool_call_id) -> result`` cache."""

    def __init__(self, max_entries: int | None = None) -> None:
        self._results: dict[tuple[str, str], Any] = {}
        self._max_entries = max_entries if max_entries is not None else _max_entries()

    @staticmethod
    def _key(instance_id: Any, tool_call_id: Any) -> tuple[str, str]:
        return (str(instance_id or ""), str(tool_call_id or ""))

    def get(self, instance_id: Any, tool_call_id: Any) -> Any | None:
        if not tool_call_id:
            return None
        return self._results.get(self._key(instance_id, tool_call_id))

    def has(self, instance_id: Any, tool_call_id: Any) -> bool:
        if not tool_call_id:
            return False
        return self._key(instance_id, tool_call_id) in self._results

    def put(self, instance_id: Any, tool_call_id: Any, result: Any) -> None:
        if not tool_call_id:
            return
        key = self._key(instance_id, tool_call_id)
        # Re-insert at the end (refresh recency) and evict oldest over the cap.
        self._results.pop(key, None)
        self._results[key] = result
        while len(self._results) > self._max_entries:
            oldest = next(iter(self._results))
            self._results.pop(oldest, None)

    def remember(
        self,
        instance_id: Any,
        tool_call_id: Any,
        producer: Callable[[], Any],
    ) -> tuple[Any, bool]:
        """Return ``(result, was_cached)``.

        On a cache hit the recorded result is returned and ``producer`` is NOT
        called (the side effect does not re-run). On a miss ``producer`` runs
        once and its result is cached. A falsy ``tool_call_id`` is never cached.
        """
        cached = self.get(instance_id, tool_call_id)
        if cached is not None:
            return cached, True
        result = producer()
        self.put(instance_id, tool_call_id, result)
        return result, False

    def clear_instance(self, instance_id: Any) -> int:
        """Drop all entries for an instance (terminal cleanup). Returns count."""
        prefix = str(instance_id or "")
        keys = [k for k in self._results if k[0] == prefix]
        for k in keys:
            self._results.pop(k, None)
        return len(keys)

    def __len__(self) -> int:
        return len(self._results)


def _msg_role(message: Any) -> Any:
    return message.get("role") if isinstance(message, dict) else getattr(message, "role", None)


def _msg_tool_call_id(message: Any) -> Any:
    if isinstance(message, dict):
        return message.get("tool_call_id")
    return getattr(message, "tool_call_id", None)


def find_recorded_tool_result(
    messages: list[Any], tool_call_id: str
) -> Optional[dict[str, Any]]:
    """Scan durable ``entry.messages`` for an already-recorded tool result.

    Pure helper (mirrors the compaction durable-sentinel scan). Returns the
    recorded tool message as a ``model_dump``-shaped dict, or ``None``. Scans
    newest-first so the most recent record wins.
    """
    if not tool_call_id:
        return None
    target = str(tool_call_id)
    for message in reversed(messages):
        if _msg_role(message) != "tool":
            continue
        if str(_msg_tool_call_id(message) or "") != target:
            continue
        if isinstance(message, dict):
            return message
        dump = getattr(message, "model_dump", None)
        if callable(dump):
            try:
                return dump()
            except Exception:  # noqa: BLE001
                pass
        return {
            "role": "tool",
            "content": getattr(message, "content", None),
            "name": getattr(message, "name", None),
            "tool_call_id": getattr(message, "tool_call_id", None),
        }
    return None


__all__ = [
    "ToolResultCache",
    "find_recorded_tool_result",
    "tool_idempotency_enabled",
    "DEFAULT_MAX_ENTRIES",
]
