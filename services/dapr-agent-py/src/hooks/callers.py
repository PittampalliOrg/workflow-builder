"""Typed per-event callers. These are the public API the agent uses.

Each function takes the event-specific fields, builds the HookInput dict,
and invokes execute_hooks with the right event + match query.

Callers are synchronous from the agent's POV: they wrap asyncio.run on
an isolated loop. Inside a Dapr activity, this is safe — we already
use the same bridge for MCP tools (src/main.py:_run_asyncio_task).
"""
from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any, Optional

from .events import HookEvent
from .executor import execute_hooks, hooks_enabled
from .registry import HooksSnapshot
from .schemas import AggregatedHookResult
from .subprocess_runner import (
    DEFAULT_HOOK_TIMEOUT_MS,
    SESSION_END_TIMEOUT_MS,
    RunnerContext,
)

logger = logging.getLogger(__name__)


def _run_coro(coro):
    """Run a coroutine on a thread-local event loop, similar to the agent's
    existing `_run_asyncio_task` bridge. Safe to call from sync code inside
    a Dapr activity."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # Running inside an event loop — run on a worker thread.
            result_box: dict[str, Any] = {}

            def _runner():
                try:
                    result_box["value"] = asyncio.run(coro)
                except BaseException as exc:  # noqa: BLE001
                    result_box["error"] = exc

            t = threading.Thread(target=_runner, daemon=True)
            t.start()
            t.join()
            if "error" in result_box:
                raise result_box["error"]  # type: ignore[misc]
            return result_box.get("value")
    except RuntimeError:
        pass
    return asyncio.run(coro)


def _make_ctx(project_dir: str, env_extra: dict[str, str] | None = None) -> RunnerContext:
    return RunnerContext(
        project_dir=project_dir or ".",
        env_extra=env_extra,
        default_timeout_ms=DEFAULT_HOOK_TIMEOUT_MS,
    )


def _empty(event: HookEvent) -> AggregatedHookResult:
    return AggregatedHookResult.empty(event.value)


def _base_input(event: HookEvent, session_id: str, cwd: str, transcript_path: str = "") -> dict[str, Any]:
    return {
        "hook_event_name": event.value,
        "session_id": session_id,
        "transcript_path": transcript_path,
        "cwd": cwd,
    }


def execute_pre_tool_hooks(
    snapshot: HooksSnapshot,
    *,
    tool_name: str,
    tool_use_id: str,
    tool_input: dict[str, Any],
    session_id: str,
    cwd: str,
    project_dir: str,
    permission_mode: Optional[str] = None,
) -> AggregatedHookResult:
    if not hooks_enabled():
        return _empty(HookEvent.PreToolUse)
    payload = _base_input(HookEvent.PreToolUse, session_id, cwd)
    payload.update({
        "permission_mode": permission_mode,
        "tool_name": tool_name,
        "tool_input": tool_input,
        "tool_use_id": tool_use_id,
    })
    return _run_coro(
        execute_hooks(
            HookEvent.PreToolUse,
            payload,
            snapshot,
            match_query=tool_name,
            runner_ctx=_make_ctx(project_dir),
        )
    )


def execute_post_tool_hooks(
    snapshot: HooksSnapshot,
    *,
    tool_name: str,
    tool_use_id: str,
    tool_input: dict[str, Any],
    tool_response: Any,
    session_id: str,
    cwd: str,
    project_dir: str,
) -> AggregatedHookResult:
    if not hooks_enabled():
        return _empty(HookEvent.PostToolUse)
    payload = _base_input(HookEvent.PostToolUse, session_id, cwd)
    payload.update({
        "tool_name": tool_name,
        "tool_input": tool_input,
        "tool_response": tool_response,
        "tool_use_id": tool_use_id,
    })
    return _run_coro(
        execute_hooks(
            HookEvent.PostToolUse,
            payload,
            snapshot,
            match_query=tool_name,
            runner_ctx=_make_ctx(project_dir),
        )
    )


def execute_post_tool_use_failure_hooks(
    snapshot: HooksSnapshot,
    *,
    tool_name: str,
    tool_use_id: str,
    tool_input: dict[str, Any],
    error: str,
    session_id: str,
    cwd: str,
    project_dir: str,
    is_interrupt: bool = False,
) -> AggregatedHookResult:
    if not hooks_enabled():
        return _empty(HookEvent.PostToolUseFailure)
    payload = _base_input(HookEvent.PostToolUseFailure, session_id, cwd)
    payload.update({
        "tool_name": tool_name,
        "tool_input": tool_input,
        "tool_use_id": tool_use_id,
        "error": error,
        "is_interrupt": is_interrupt,
    })
    return _run_coro(
        execute_hooks(
            HookEvent.PostToolUseFailure,
            payload,
            snapshot,
            match_query=tool_name,
            runner_ctx=_make_ctx(project_dir),
        )
    )


def execute_user_prompt_submit_hooks(
    snapshot: HooksSnapshot,
    *,
    prompt: str,
    session_id: str,
    cwd: str,
    project_dir: str,
) -> AggregatedHookResult:
    if not hooks_enabled():
        return _empty(HookEvent.UserPromptSubmit)
    payload = _base_input(HookEvent.UserPromptSubmit, session_id, cwd)
    payload["prompt"] = prompt
    return _run_coro(
        execute_hooks(
            HookEvent.UserPromptSubmit,
            payload,
            snapshot,
            runner_ctx=_make_ctx(project_dir),
        )
    )


def execute_session_start_hooks(
    snapshot: HooksSnapshot,
    *,
    source: str,
    session_id: str,
    cwd: str,
    project_dir: str,
) -> AggregatedHookResult:
    if not hooks_enabled():
        return _empty(HookEvent.SessionStart)
    payload = _base_input(HookEvent.SessionStart, session_id, cwd)
    payload["source"] = source
    return _run_coro(
        execute_hooks(
            HookEvent.SessionStart,
            payload,
            snapshot,
            match_query=source,
            runner_ctx=_make_ctx(project_dir),
        )
    )


def execute_session_end_hooks(
    snapshot: HooksSnapshot,
    *,
    reason: str,
    session_id: str,
    cwd: str,
    project_dir: str,
) -> AggregatedHookResult:
    if not hooks_enabled():
        return _empty(HookEvent.SessionEnd)
    payload = _base_input(HookEvent.SessionEnd, session_id, cwd)
    payload["reason"] = reason
    return _run_coro(
        execute_hooks(
            HookEvent.SessionEnd,
            payload,
            snapshot,
            match_query=reason,
            runner_ctx=RunnerContext(
                project_dir=project_dir or ".",
                default_timeout_ms=SESSION_END_TIMEOUT_MS,
            ),
        )
    )


def execute_stop_hooks(
    snapshot: HooksSnapshot,
    *,
    session_id: str,
    cwd: str,
    project_dir: str,
    stop_hook_active: bool = False,
    last_assistant_message: str = "",
) -> AggregatedHookResult:
    if not hooks_enabled():
        return _empty(HookEvent.Stop)
    payload = _base_input(HookEvent.Stop, session_id, cwd)
    payload.update({
        "stop_hook_active": stop_hook_active,
        "last_assistant_message": last_assistant_message,
    })
    return _run_coro(
        execute_hooks(
            HookEvent.Stop,
            payload,
            snapshot,
            runner_ctx=_make_ctx(project_dir),
        )
    )


def execute_notification_hooks(
    snapshot: HooksSnapshot,
    *,
    message: str,
    session_id: str,
    cwd: str,
    project_dir: str,
    title: Optional[str] = None,
    notification_type: Optional[str] = None,
) -> AggregatedHookResult:
    if not hooks_enabled():
        return _empty(HookEvent.Notification)
    payload = _base_input(HookEvent.Notification, session_id, cwd)
    payload.update({
        "message": message,
        "title": title,
        "notification_type": notification_type,
    })
    return _run_coro(
        execute_hooks(
            HookEvent.Notification,
            payload,
            snapshot,
            match_query=notification_type or "",
            runner_ctx=_make_ctx(project_dir),
        )
    )


__all__ = [
    "execute_pre_tool_hooks",
    "execute_post_tool_hooks",
    "execute_post_tool_use_failure_hooks",
    "execute_user_prompt_submit_hooks",
    "execute_session_start_hooks",
    "execute_session_end_hooks",
    "execute_stop_hooks",
    "execute_notification_hooks",
]
