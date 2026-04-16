"""Hook subsystem — command + callback hooks, settings/plugin driven.

Public surface:
    HookEvent, V1_EMITTED_EVENTS
    HookRegistry, HooksSnapshot, empty_snapshot
    HooksSettings, HookMatcher, AggregatedHookResult
    execute_*_hooks callers
    hooks_enabled
"""
from __future__ import annotations

from .callers import (
    execute_notification_hooks,
    execute_post_tool_hooks,
    execute_post_tool_use_failure_hooks,
    execute_pre_tool_hooks,
    execute_session_end_hooks,
    execute_session_start_hooks,
    execute_stop_hooks,
    execute_user_prompt_submit_hooks,
)
from .events import ALL_EVENTS, V1_EMITTED_EVENTS, HookEvent
from .executor import event_allowed, execute_hooks, hooks_enabled
from .registry import HookRegistry, HooksSnapshot, empty_snapshot
from .schemas import (
    AggregatedHookResult,
    BashCommandHook,
    CallbackHook,
    HookMatcher,
    HookResult,
    HooksSettings,
    SyncHookJSONOutput,
)
from .settings_loader import LoadedSettings, load_cascade, policy_flags

__all__ = [
    "HookEvent",
    "ALL_EVENTS",
    "V1_EMITTED_EVENTS",
    "HookRegistry",
    "HooksSnapshot",
    "empty_snapshot",
    "HooksSettings",
    "HookMatcher",
    "BashCommandHook",
    "CallbackHook",
    "HookResult",
    "SyncHookJSONOutput",
    "AggregatedHookResult",
    "LoadedSettings",
    "load_cascade",
    "policy_flags",
    "hooks_enabled",
    "event_allowed",
    "execute_hooks",
    "execute_pre_tool_hooks",
    "execute_post_tool_hooks",
    "execute_post_tool_use_failure_hooks",
    "execute_user_prompt_submit_hooks",
    "execute_session_start_hooks",
    "execute_session_end_hooks",
    "execute_stop_hooks",
    "execute_notification_hooks",
]
