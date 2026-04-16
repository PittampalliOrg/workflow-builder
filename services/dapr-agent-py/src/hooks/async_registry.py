"""Async hook registry for background hooks.

Ported from claude-code-src/main/utils/hooks/AsyncHookRegistry.ts.

Tracks pending background hook processes and polls for completion.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_ASYNC_TIMEOUT_MS = 15_000


@dataclass
class PendingAsyncHook:
    """A background hook awaiting completion."""

    hook_id: str
    command: str
    started_at: float = field(default_factory=time.monotonic)
    timeout_ms: int = DEFAULT_ASYNC_TIMEOUT_MS
    result: dict[str, Any] | None = None
    completed: bool = False
    exit_code: int | None = None


class AsyncHookRegistry:
    """Thread-safe registry for pending async hooks."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pending: dict[str, PendingAsyncHook] = {}

    def register(
        self,
        hook_id: str,
        command: str,
        timeout_ms: int = DEFAULT_ASYNC_TIMEOUT_MS,
    ) -> None:
        with self._lock:
            self._pending[hook_id] = PendingAsyncHook(
                hook_id=hook_id,
                command=command,
                timeout_ms=timeout_ms,
            )

    def mark_completed(
        self,
        hook_id: str,
        result: dict[str, Any] | None = None,
        exit_code: int = 0,
    ) -> None:
        with self._lock:
            hook = self._pending.get(hook_id)
            if hook:
                hook.completed = True
                hook.result = result
                hook.exit_code = exit_code

    def check_for_responses(self) -> list[PendingAsyncHook]:
        """Return completed async hooks and remove them from the registry."""
        now = time.monotonic()
        completed: list[PendingAsyncHook] = []

        with self._lock:
            expired_ids: list[str] = []
            for hook_id, hook in self._pending.items():
                if hook.completed:
                    completed.append(hook)
                    expired_ids.append(hook_id)
                elif (now - hook.started_at) * 1000 > hook.timeout_ms:
                    # Timed out
                    hook.completed = True
                    hook.exit_code = -1
                    completed.append(hook)
                    expired_ids.append(hook_id)

            for hook_id in expired_ids:
                del self._pending[hook_id]

        return completed

    def finalize_all(self) -> list[PendingAsyncHook]:
        """Return and clear all pending hooks (for session cleanup)."""
        with self._lock:
            all_hooks = list(self._pending.values())
            self._pending.clear()
        return all_hooks

    def has_pending(self) -> bool:
        with self._lock:
            return bool(self._pending)


# Module-level singleton
_registry = AsyncHookRegistry()


def get_async_hook_registry() -> AsyncHookRegistry:
    return _registry
