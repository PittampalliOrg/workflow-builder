"""Legacy `with_session_events` decorator for tool_call_* events.

Diagrid's `execute_tool_activity` invokes `tool.run_async(args=..., tool_context=...)`
where `tool` is an ADK `BaseTool` (typically `FunctionTool`). `FunctionTool`
inspects the wrapped function's signature and injects a `tool_context`
parameter only when the function declares it explicitly.

The canonical event source is now `src.telemetry.diagrid_adk`, which emits
stable tool call ids from the durable activity wrapper. This decorator remains
as an explicit fallback for local debugging only.
"""

from __future__ import annotations

import functools
import logging
import os
import threading
from typing import Any, Callable

logger = logging.getLogger(__name__)

_SEQ_LOCK = threading.Lock()
_SEQ_BY_TOOL: dict[str, int] = {}


def _next_seq(tool_name: str) -> int:
    with _SEQ_LOCK:
        next_val = _SEQ_BY_TOOL.get(tool_name, 0) + 1
        _SEQ_BY_TOOL[tool_name] = next_val
        return next_val


def _scoped_session_id() -> str | None:
    try:
        from src.openshell_runtime import get_runtime

        sid = get_runtime().session_id
    except Exception:
        sid = None
    return sid or None


def _truncate(value: Any, *, limit: int = 4_096) -> Any:
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + f"... [+{len(value) - limit} chars truncated]"
    return value


def _legacy_events_enabled() -> bool:
    return os.environ.get(
        "ADK_LEGACY_TOOL_BODY_SESSION_EVENTS", ""
    ).strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def with_session_events(
    tool_name: str,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Wrap a FunctionTool body to emit `tool_call_start` / `tool_call_end`
    / `tool_call_error` CMA events when the legacy fallback is enabled."""

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(fn)
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            if not _legacy_events_enabled():
                return fn(*args, **kwargs)

            session_id = _scoped_session_id()
            seq = _next_seq(tool_name)
            source_event_id = f"{tool_name}:{session_id or 'no-session'}:{seq}"
            try:
                from src.event_publisher import publish_session_event

                if session_id:
                    publish_session_event(
                        session_id,
                        "tool_call_start",
                        {
                            "toolName": tool_name,
                            "args": _truncate(kwargs),
                        },
                        source_event_id=f"{source_event_id}:start",
                    )
            except Exception as exc:  # noqa: BLE001
                logger.debug("[tool-wrap] publish start failed: %s", exc)

            try:
                result = fn(*args, **kwargs)
            except Exception as exc:
                try:
                    from src.event_publisher import publish_session_event

                    if session_id:
                        publish_session_event(
                            session_id,
                            "tool_call_error",
                            {
                                "toolName": tool_name,
                                "error": str(exc),
                            },
                            source_event_id=f"{source_event_id}:error",
                        )
                except Exception:
                    pass
                raise

            try:
                from src.event_publisher import publish_session_event

                if session_id:
                    publish_session_event(
                        session_id,
                        "tool_call_end",
                        {
                            "toolName": tool_name,
                            "output": _truncate(result),
                        },
                        source_event_id=f"{source_event_id}:end",
                    )
            except Exception as exc:  # noqa: BLE001
                logger.debug("[tool-wrap] publish end failed: %s", exc)

            return result

        return wrapped

    return decorator
