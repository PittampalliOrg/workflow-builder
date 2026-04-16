"""Hook event enum, mirroring TS HOOK_EVENTS.

String values are identical to TS so plugin JSON round-trips. See
claude-code-src/main/entrypoints/sdk/coreTypes.ts:25-53.
"""
from __future__ import annotations

from enum import Enum


class HookEvent(str, Enum):
    PreToolUse = "PreToolUse"
    PostToolUse = "PostToolUse"
    PostToolUseFailure = "PostToolUseFailure"
    Notification = "Notification"
    UserPromptSubmit = "UserPromptSubmit"
    SessionStart = "SessionStart"
    SessionEnd = "SessionEnd"
    Stop = "Stop"
    StopFailure = "StopFailure"
    SubagentStart = "SubagentStart"
    SubagentStop = "SubagentStop"
    PreCompact = "PreCompact"
    PostCompact = "PostCompact"
    PermissionRequest = "PermissionRequest"
    PermissionDenied = "PermissionDenied"
    Setup = "Setup"
    TeammateIdle = "TeammateIdle"
    TaskCreated = "TaskCreated"
    TaskCompleted = "TaskCompleted"
    Elicitation = "Elicitation"
    ElicitationResult = "ElicitationResult"
    ConfigChange = "ConfigChange"
    WorktreeCreate = "WorktreeCreate"
    WorktreeRemove = "WorktreeRemove"
    InstructionsLoaded = "InstructionsLoaded"
    CwdChanged = "CwdChanged"
    FileChanged = "FileChanged"


ALL_EVENTS: tuple[HookEvent, ...] = tuple(HookEvent)

# Events the dapr-agent-py runtime actually emits in v1.
# Others are accepted in config for plugin JSON compatibility but never fire.
V1_EMITTED_EVENTS: frozenset[HookEvent] = frozenset({
    HookEvent.PreToolUse,
    HookEvent.PostToolUse,
    HookEvent.PostToolUseFailure,
    HookEvent.UserPromptSubmit,
    HookEvent.SessionStart,
    HookEvent.SessionEnd,
    HookEvent.Stop,
    HookEvent.Notification,
    HookEvent.PreCompact,
    HookEvent.PostCompact,
})
