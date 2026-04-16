"""Hooks system for dapr-agent-py.

Ported from claude-code-src/main/utils/hooks.ts and related files.

Provides lifecycle hooks that execute at key agent events (tool execution,
session start/end, etc.).  Hook commands (shell, HTTP, prompt, agent,
callback) are matched by event type and optional pattern, then run in
parallel with individual timeouts.

Durability note
---------------
* Hooks called inside **activity methods** (``run_tool``, ``call_llm``)
  are replay-safe — the Dapr workflow runtime caches the activity result
  and will not re-execute hooks on replay.
* Hooks called in **workflow code** (``agent_workflow``) MUST be guarded
  with ``if not ctx.is_replaying:`` to prevent duplicate side-effects.
"""

from __future__ import annotations

from .types import (
    AggregatedHookResult,
    HookEvent,
    HookResult,
)
from .executor import execute_hooks
from .registry import HookRegistry, get_hook_registry

__all__ = [
    "AggregatedHookResult",
    "HookEvent",
    "HookRegistry",
    "HookResult",
    "execute_hooks",
    "execute_pre_tool_hooks",
    "execute_post_tool_hooks",
    "execute_post_tool_failure_hooks",
    "execute_session_start_hooks",
    "execute_session_end_hooks",
    "execute_stop_hooks",
    "execute_notification_hooks",
    "get_hook_registry",
]


# ---------------------------------------------------------------------------
# Convenience functions (mirror claude-code-src executePreToolHooks, etc.)
# ---------------------------------------------------------------------------


def execute_pre_tool_hooks(
    tool_name: str,
    tool_use_id: str,
    tool_input: dict,
    *,
    session_id: str = "",
    cwd: str = "",
    project_root: str = "",
    timeout_ms: int = 600_000,
) -> AggregatedHookResult:
    """Run PreToolUse hooks.  Safe inside ``run_tool()`` (activity)."""
    from .types import PreToolUseHookInput

    hook_input = PreToolUseHookInput(
        hook_event_name=HookEvent.PRE_TOOL_USE,
        session_id=session_id,
        cwd=cwd,
        project_root=project_root,
        tool_name=tool_name,
        tool_input=tool_input,
        tool_use_id=tool_use_id,
    )
    return execute_hooks(
        hook_event=HookEvent.PRE_TOOL_USE,
        hook_input=hook_input,
        session_id=session_id,
        match_query=tool_name,
        timeout_ms=timeout_ms,
    )


def execute_post_tool_hooks(
    tool_name: str,
    tool_use_id: str,
    tool_input: dict,
    tool_response: str,
    *,
    session_id: str = "",
    cwd: str = "",
    project_root: str = "",
    timeout_ms: int = 600_000,
) -> AggregatedHookResult:
    """Run PostToolUse hooks.  Safe inside ``run_tool()`` (activity)."""
    from .types import PostToolUseHookInput

    hook_input = PostToolUseHookInput(
        hook_event_name=HookEvent.POST_TOOL_USE,
        session_id=session_id,
        cwd=cwd,
        project_root=project_root,
        tool_name=tool_name,
        tool_input=tool_input,
        tool_use_id=tool_use_id,
        tool_response=tool_response,
    )
    return execute_hooks(
        hook_event=HookEvent.POST_TOOL_USE,
        hook_input=hook_input,
        session_id=session_id,
        match_query=tool_name,
        timeout_ms=timeout_ms,
    )


def execute_post_tool_failure_hooks(
    tool_name: str,
    tool_use_id: str,
    tool_input: dict,
    error: str,
    *,
    is_interrupt: bool = False,
    session_id: str = "",
    cwd: str = "",
    project_root: str = "",
    timeout_ms: int = 600_000,
) -> AggregatedHookResult:
    """Run PostToolUseFailure hooks.  Safe inside ``run_tool()`` (activity)."""
    from .types import PostToolUseFailureHookInput

    hook_input = PostToolUseFailureHookInput(
        hook_event_name=HookEvent.POST_TOOL_USE_FAILURE,
        session_id=session_id,
        cwd=cwd,
        project_root=project_root,
        tool_name=tool_name,
        tool_input=tool_input,
        tool_use_id=tool_use_id,
        error=error,
        is_interrupt=is_interrupt,
    )
    return execute_hooks(
        hook_event=HookEvent.POST_TOOL_USE_FAILURE,
        hook_input=hook_input,
        session_id=session_id,
        match_query=tool_name,
        timeout_ms=timeout_ms,
    )


def execute_session_start_hooks(
    source: str,
    *,
    session_id: str = "",
    cwd: str = "",
    project_root: str = "",
    timeout_ms: int = 600_000,
) -> AggregatedHookResult:
    """Run SessionStart hooks.  MUST be guarded with ``is_replaying``."""
    from .types import SessionStartHookInput

    hook_input = SessionStartHookInput(
        hook_event_name=HookEvent.SESSION_START,
        session_id=session_id,
        cwd=cwd,
        project_root=project_root,
        source=source,
    )
    return execute_hooks(
        hook_event=HookEvent.SESSION_START,
        hook_input=hook_input,
        session_id=session_id,
        match_query=source,
        timeout_ms=timeout_ms,
    )


def execute_session_end_hooks(
    reason: str,
    *,
    session_id: str = "",
    cwd: str = "",
    project_root: str = "",
    timeout_ms: int = 1_500,
) -> AggregatedHookResult:
    """Run SessionEnd hooks.  MUST be guarded with ``is_replaying``."""
    from .types import SessionEndHookInput

    hook_input = SessionEndHookInput(
        hook_event_name=HookEvent.SESSION_END,
        session_id=session_id,
        cwd=cwd,
        project_root=project_root,
        reason=reason,
    )
    return execute_hooks(
        hook_event=HookEvent.SESSION_END,
        hook_input=hook_input,
        session_id=session_id,
        match_query=reason,
        timeout_ms=timeout_ms,
    )


def execute_stop_hooks(
    *,
    session_id: str = "",
    cwd: str = "",
    project_root: str = "",
    timeout_ms: int = 600_000,
) -> AggregatedHookResult:
    """Run Stop hooks.  Safe inside ``call_llm()`` (activity)."""
    from .types import StopHookInput

    hook_input = StopHookInput(
        hook_event_name=HookEvent.STOP,
        session_id=session_id,
        cwd=cwd,
        project_root=project_root,
    )
    return execute_hooks(
        hook_event=HookEvent.STOP,
        hook_input=hook_input,
        session_id=session_id,
        timeout_ms=timeout_ms,
    )


def execute_notification_hooks(
    message: str,
    notification_type: str,
    *,
    title: str = "",
    session_id: str = "",
    cwd: str = "",
    project_root: str = "",
    timeout_ms: int = 600_000,
) -> AggregatedHookResult:
    """Run Notification hooks."""
    from .types import NotificationHookInput

    hook_input = NotificationHookInput(
        hook_event_name=HookEvent.NOTIFICATION,
        session_id=session_id,
        cwd=cwd,
        project_root=project_root,
        message=message,
        notification_type=notification_type,
        title=title,
    )
    return execute_hooks(
        hook_event=HookEvent.NOTIFICATION,
        hook_input=hook_input,
        session_id=session_id,
        match_query=notification_type,
        timeout_ms=timeout_ms,
    )
