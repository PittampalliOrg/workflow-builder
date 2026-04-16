"""Thread-safe hook registry.

Ported from claude-code-src/main/utils/hooks/sessionHooks.ts and the
hook-registration portions of utils/hooks.ts.

Follows the same singleton pattern as ``SkillRegistry`` in
``src/tools/skill_tool/tool.py``.
"""

from __future__ import annotations

import logging
import threading
import uuid
from typing import Callable

from .types import (
    CallbackHookConfig,
    FunctionHookConfig,
    HookCommand,
    HookEvent,
    HookMatcher,
    SessionHookMatcher,
)

logger = logging.getLogger(__name__)


class HookRegistry:
    """Thread-safe central registry for hook configurations from all sources."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # Settings-based hooks (from config files, highest priority)
        self._settings: dict[HookEvent, list[HookMatcher]] = {}
        # Registered hooks (from plugins/SDK)
        self._registered: dict[HookEvent, list[HookMatcher]] = {}
        # Session hooks (ephemeral, per session_id)
        self._session: dict[str, dict[HookEvent, list[SessionHookMatcher]]] = {}

    # -- Settings hooks -------------------------------------------------------

    def load_from_settings(self, hooks_settings: dict[str, list[dict]]) -> None:
        """Load hooks from a parsed settings dict (``hooks`` key from settings.json).

        Expected format::

            {
                "PreToolUse": [
                    {"matcher": "Write", "hooks": [{"type": "command", ...}]}
                ],
                ...
            }
        """
        from .config import parse_hooks_settings

        with self._lock:
            self._settings = parse_hooks_settings(hooks_settings)

    def get_settings_hooks(self, event: HookEvent) -> list[HookMatcher]:
        with self._lock:
            return list(self._settings.get(event, []))

    # -- Registered hooks (plugin/SDK) ----------------------------------------

    def register_hooks(
        self,
        event: HookEvent,
        matchers: list[HookMatcher],
    ) -> None:
        with self._lock:
            existing = self._registered.setdefault(event, [])
            existing.extend(matchers)

    def clear_registered_hooks(self) -> None:
        with self._lock:
            self._registered.clear()

    def get_registered_hooks(self, event: HookEvent) -> list[HookMatcher]:
        with self._lock:
            return list(self._registered.get(event, []))

    # -- Session hooks (ephemeral) --------------------------------------------

    def add_session_hook(
        self,
        session_id: str,
        event: HookEvent,
        matcher: str,
        hook: HookCommand,
        on_hook_success: Callable[..., None] | None = None,
        skill_root: str = "",
    ) -> None:
        """Add a session-scoped hook."""
        with self._lock:
            session = self._session.setdefault(session_id, {})
            matchers = session.setdefault(event, [])
            matchers.append(
                SessionHookMatcher(
                    hooks=[hook],
                    matcher=matcher,
                    on_hook_success=on_hook_success,
                    skill_root=skill_root,
                )
            )

    def add_function_hook(
        self,
        session_id: str,
        event: HookEvent,
        matcher: str,
        callback: Callable[..., bool],
        error_message: str,
        timeout: int = 0,
        hook_id: str = "",
    ) -> str:
        """Add a session-scoped function hook.  Returns the hook ID."""
        if not hook_id:
            hook_id = str(uuid.uuid4())
        hook = FunctionHookConfig(
            callback=callback,
            error_message=error_message,
            timeout=timeout,
            id=hook_id,
        )
        with self._lock:
            session = self._session.setdefault(session_id, {})
            matchers = session.setdefault(event, [])
            matchers.append(SessionHookMatcher(hooks=[hook], matcher=matcher))
        return hook_id

    def remove_function_hook(
        self,
        session_id: str,
        event: HookEvent,
        hook_id: str,
    ) -> None:
        """Remove a function hook by ID."""
        with self._lock:
            session = self._session.get(session_id, {})
            matchers = session.get(event, [])
            session[event] = [
                m
                for m in matchers
                if not any(
                    getattr(h, "id", "") == hook_id
                    for h in m.hooks
                    if isinstance(h, FunctionHookConfig)
                )
            ]

    def clear_session_hooks(self, session_id: str) -> None:
        """Remove all hooks for a session."""
        with self._lock:
            self._session.pop(session_id, None)

    def get_session_hooks(
        self,
        session_id: str,
        event: HookEvent,
    ) -> list[SessionHookMatcher]:
        with self._lock:
            session = self._session.get(session_id, {})
            return list(session.get(event, []))

    # -- Combined lookup ------------------------------------------------------

    def get_all_for_event(
        self,
        session_id: str,
        event: HookEvent,
    ) -> tuple[list[HookMatcher], list[HookMatcher], list[SessionHookMatcher]]:
        """Return (settings, registered, session) matchers for an event."""
        with self._lock:
            settings = list(self._settings.get(event, []))
            registered = list(self._registered.get(event, []))
            session = list(self._session.get(session_id, {}).get(event, []))
        return settings, registered, session

    def has_hooks_for_event(self, session_id: str, event: HookEvent) -> bool:
        """Quick check whether any hooks are registered for an event."""
        with self._lock:
            if self._settings.get(event):
                return True
            if self._registered.get(event):
                return True
            session = self._session.get(session_id, {})
            if session.get(event):
                return True
        return False


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_registry = HookRegistry()


def get_hook_registry() -> HookRegistry:
    """Return the module-level hook registry singleton."""
    return _registry
