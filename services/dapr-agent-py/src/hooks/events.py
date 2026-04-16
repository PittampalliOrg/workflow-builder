"""Hook execution event broadcasting.

Ported from claude-code-src/main/utils/hooks/hookEvents.ts.

Broadcasts hook lifecycle events (started, progress, response) to
registered handlers.  Used for observability and streaming to external
consumers.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Any, Callable

from .types import HookEvent, HookOutcome

logger = logging.getLogger(__name__)


@dataclass
class HookExecutionEvent:
    """A hook lifecycle event."""

    event_type: str  # "started" | "progress" | "response"
    hook_event: HookEvent
    hook_name: str = ""
    command: str = ""
    outcome: HookOutcome | None = None
    output: str = ""
    status_message: str = ""


# Handler type
HookEventHandler = Callable[[HookExecutionEvent], None]

_lock = threading.Lock()
_handlers: list[HookEventHandler] = []
_pending_events: list[HookExecutionEvent] = []
_MAX_PENDING = 100


def register_hook_event_handler(handler: HookEventHandler) -> None:
    """Register a handler for hook execution events.

    Any pending (buffered) events are delivered immediately.
    """
    with _lock:
        _handlers.append(handler)
        # Deliver pending events
        for event in _pending_events:
            try:
                handler(event)
            except Exception:
                logger.debug("Hook event handler failed during pending delivery", exc_info=True)
        _pending_events.clear()


def _emit(event: HookExecutionEvent) -> None:
    """Emit an event to all handlers, or buffer if none registered."""
    with _lock:
        if not _handlers:
            if len(_pending_events) < _MAX_PENDING:
                _pending_events.append(event)
            return
        for handler in _handlers:
            try:
                handler(event)
            except Exception:
                logger.debug("Hook event handler failed", exc_info=True)


def emit_hook_started(
    hook_event: HookEvent,
    hook_name: str,
    command: str = "",
    status_message: str = "",
) -> None:
    _emit(
        HookExecutionEvent(
            event_type="started",
            hook_event=hook_event,
            hook_name=hook_name,
            command=command,
            status_message=status_message,
        )
    )


def emit_hook_progress(
    hook_event: HookEvent,
    hook_name: str,
    output: str = "",
) -> None:
    _emit(
        HookExecutionEvent(
            event_type="progress",
            hook_event=hook_event,
            hook_name=hook_name,
            output=output,
        )
    )


def emit_hook_response(
    hook_event: HookEvent,
    hook_name: str,
    outcome: HookOutcome,
    output: str = "",
) -> None:
    _emit(
        HookExecutionEvent(
            event_type="response",
            hook_event=hook_event,
            hook_name=hook_name,
            outcome=outcome,
            output=output,
        )
    )
