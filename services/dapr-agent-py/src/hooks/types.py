"""Hook type definitions.

Ported from claude-code-src/main/types/hooks.ts and schemas/hooks.ts.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any, Callable, Union


# ---------------------------------------------------------------------------
# Hook events (27 total, mirrors HOOK_EVENTS in types/hooks.ts)
# ---------------------------------------------------------------------------


class HookEvent(str, enum.Enum):
    PRE_TOOL_USE = "PreToolUse"
    POST_TOOL_USE = "PostToolUse"
    POST_TOOL_USE_FAILURE = "PostToolUseFailure"
    SESSION_START = "SessionStart"
    SESSION_END = "SessionEnd"
    USER_PROMPT_SUBMIT = "UserPromptSubmit"
    SUBAGENT_START = "SubagentStart"
    SUBAGENT_STOP = "SubagentStop"
    TASK_CREATED = "TaskCreated"
    TASK_COMPLETED = "TaskCompleted"
    FILE_CHANGED = "FileChanged"
    CWD_CHANGED = "CwdChanged"
    NOTIFICATION = "Notification"
    CONFIG_CHANGE = "ConfigChange"
    STOP = "Stop"
    STOP_FAILURE = "StopFailure"
    PERMISSION_REQUEST = "PermissionRequest"
    PERMISSION_DENIED = "PermissionDenied"
    SETUP = "Setup"
    PRE_COMPACT = "PreCompact"
    POST_COMPACT = "PostCompact"
    TEAMMATE_IDLE = "TeammateIdle"
    ELICITATION = "Elicitation"
    ELICITATION_RESULT = "ElicitationResult"
    INSTRUCTIONS_LOADED = "InstructionsLoaded"
    WORKTREE_CREATE = "WorktreeCreate"
    WORKTREE_REMOVE = "WorktreeRemove"


# ---------------------------------------------------------------------------
# Hook command config types (serializable to settings JSON)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CommandHookConfig:
    """Shell command hook.  Receives JSON on stdin, returns JSON on stdout."""

    command: str
    type: str = "command"
    if_condition: str = ""  # Permission-rule syntax filter (maps to TS "if")
    shell: str = "bash"
    timeout: int = 0  # Seconds; 0 = use executor default
    status_message: str = ""
    once: bool = False
    async_: bool = False  # "async" is reserved in Python
    async_rewake: bool = False


@dataclass(frozen=True)
class PromptHookConfig:
    """LLM prompt hook.  $ARGUMENTS is replaced with JSON input."""

    prompt: str
    type: str = "prompt"
    if_condition: str = ""
    timeout: int = 0
    model: str = ""
    status_message: str = ""
    once: bool = False


@dataclass(frozen=True)
class AgentHookConfig:
    """Multi-turn LLM agent verification hook."""

    prompt: str
    type: str = "agent"
    if_condition: str = ""
    timeout: int = 60
    model: str = ""
    status_message: str = ""
    once: bool = False


@dataclass(frozen=True)
class HttpHookConfig:
    """HTTP POST hook.  Sends JSON input, receives JSON response."""

    url: str
    type: str = "http"
    if_condition: str = ""
    timeout: int = 0
    headers: dict[str, str] = field(default_factory=dict)
    allowed_env_vars: tuple[str, ...] = ()
    status_message: str = ""
    once: bool = False


# Serializable hook command union (can be stored in settings JSON)
HookCommand = Union[CommandHookConfig, PromptHookConfig, AgentHookConfig, HttpHookConfig]


# ---------------------------------------------------------------------------
# Programmatic hook types (not serializable)
# ---------------------------------------------------------------------------


@dataclass
class CallbackHookConfig:
    """Direct Python callable hook (SDK/plugin use)."""

    callback: Callable[..., Any]
    type: str = "callback"
    timeout: int = 0
    internal: bool = False


@dataclass
class FunctionHookConfig:
    """Session-scoped validation callback."""

    callback: Callable[..., bool]
    error_message: str
    type: str = "function"
    timeout: int = 0
    id: str = ""


# ---------------------------------------------------------------------------
# Hook matcher (groups hooks with an optional pattern)
# ---------------------------------------------------------------------------


@dataclass
class HookMatcher:
    """A matcher + list of hooks, optionally scoped to a plugin."""

    hooks: list[HookCommand]
    matcher: str = ""  # Empty = match all
    plugin_root: str = ""
    plugin_id: str = ""


@dataclass
class SessionHookMatcher:
    """Ephemeral session-scoped hook matcher."""

    hooks: list[HookCommand | CallbackHookConfig | FunctionHookConfig]
    matcher: str = ""
    on_hook_success: Callable[..., None] | None = None
    skill_root: str = ""


# ---------------------------------------------------------------------------
# Hook input types (JSON sent to hooks)
# ---------------------------------------------------------------------------


@dataclass
class HookInput:
    """Base hook input — common fields for all events."""

    hook_event_name: HookEvent
    session_id: str = ""
    cwd: str = ""
    project_root: str = ""
    tool_use_id: str = ""


@dataclass
class PreToolUseHookInput(HookInput):
    tool_name: str = ""
    tool_input: dict = field(default_factory=dict)


@dataclass
class PostToolUseHookInput(HookInput):
    tool_name: str = ""
    tool_input: dict = field(default_factory=dict)
    tool_response: str = ""


@dataclass
class PostToolUseFailureHookInput(HookInput):
    tool_name: str = ""
    tool_input: dict = field(default_factory=dict)
    error: str = ""
    is_interrupt: bool = False


@dataclass
class SessionStartHookInput(HookInput):
    source: str = ""  # "startup" | "resume" | "clear" | "compact"


@dataclass
class SessionEndHookInput(HookInput):
    reason: str = ""


@dataclass
class UserPromptSubmitHookInput(HookInput):
    user_input: str = ""
    parsed_command: str = ""


@dataclass
class SubagentStartHookInput(HookInput):
    agent_type: str = ""
    agent_id: str = ""


@dataclass
class SubagentStopHookInput(HookInput):
    agent_type: str = ""
    agent_id: str = ""


@dataclass
class TaskCreatedHookInput(HookInput):
    task_id: str = ""
    task_title: str = ""


@dataclass
class TaskCompletedHookInput(HookInput):
    task_id: str = ""
    task_title: str = ""


@dataclass
class FileChangedHookInput(HookInput):
    file_path: str = ""
    change_type: str = ""


@dataclass
class CwdChangedHookInput(HookInput):
    old_cwd: str = ""
    new_cwd: str = ""


@dataclass
class NotificationHookInput(HookInput):
    message: str = ""
    notification_type: str = ""
    title: str = ""


@dataclass
class ConfigChangeHookInput(HookInput):
    source: str = ""


@dataclass
class StopHookInput(HookInput):
    pass


@dataclass
class StopFailureHookInput(HookInput):
    error: str = ""


@dataclass
class PermissionRequestHookInput(HookInput):
    tool_name: str = ""
    action: str = ""
    message: str = ""


@dataclass
class PermissionDeniedHookInput(HookInput):
    tool_name: str = ""
    reason: str = ""
    action: str = ""


@dataclass
class SetupHookInput(HookInput):
    trigger: str = ""  # "init" | "maintenance"


@dataclass
class PreCompactHookInput(HookInput):
    trigger: str = ""


@dataclass
class PostCompactHookInput(HookInput):
    trigger: str = ""


@dataclass
class TeammateIdleHookInput(HookInput):
    pass


@dataclass
class ElicitationHookInput(HookInput):
    mcp_server_name: str = ""


@dataclass
class ElicitationResultHookInput(HookInput):
    mcp_server_name: str = ""


@dataclass
class InstructionsLoadedHookInput(HookInput):
    load_reason: str = ""


@dataclass
class WorktreeCreateHookInput(HookInput):
    worktree_path: str = ""


@dataclass
class WorktreeRemoveHookInput(HookInput):
    worktree_path: str = ""


# ---------------------------------------------------------------------------
# Hook output / result types
# ---------------------------------------------------------------------------


@dataclass
class HookBlockingError:
    """Describes a hook that blocked execution."""

    blocking_error: str
    command: str


class HookOutcome(str, enum.Enum):
    SUCCESS = "success"
    BLOCKING = "blocking"
    NON_BLOCKING_ERROR = "non_blocking_error"
    CANCELLED = "cancelled"


@dataclass
class HookResult:
    """Result from a single hook execution."""

    outcome: HookOutcome = HookOutcome.SUCCESS
    blocking_error: HookBlockingError | None = None
    prevent_continuation: bool = False
    stop_reason: str = ""
    permission_behavior: str = ""  # "ask" | "deny" | "allow" | "passthrough"
    permission_decision_reason: str = ""
    additional_context: str = ""
    initial_user_message: str = ""
    updated_input: dict[str, Any] | None = None
    updated_mcp_tool_output: Any = None
    retry: bool = False
    message: str = ""
    system_message: str = ""
    watch_paths: list[str] = field(default_factory=list)


@dataclass
class AggregatedHookResult:
    """Combined result from all hooks for one event invocation."""

    blocking_errors: list[HookBlockingError] = field(default_factory=list)
    prevent_continuation: bool = False
    stop_reason: str = ""
    permission_behavior: str = ""
    permission_decision_reason: str = ""
    additional_contexts: list[str] = field(default_factory=list)
    initial_user_message: str = ""
    updated_input: dict[str, Any] | None = None
    updated_mcp_tool_output: Any = None
    retry: bool = False
    messages: list[str] = field(default_factory=list)
    watch_paths: list[str] = field(default_factory=list)

    @property
    def has_blocking_errors(self) -> bool:
        return len(self.blocking_errors) > 0
