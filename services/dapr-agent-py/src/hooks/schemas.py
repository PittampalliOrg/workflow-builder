"""Pydantic models for hook configuration, I/O, and aggregation.

TS compatibility: all alias keys match the TS JSON shape. Models use
populate_by_name=True so snake_case Python access works while
`.model_dump(by_alias=True)` produces TS-compatible JSON.
"""
from __future__ import annotations

from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field


_BaseConfig = ConfigDict(populate_by_name=True, extra="ignore")


# ---------------------------------------------------------------------------
# Hook commands (the configured hook entries inside settings / plugin JSON)
# ---------------------------------------------------------------------------


class _HookCommandBase(BaseModel):
    model_config = _BaseConfig

    if_: Optional[str] = Field(default=None, alias="if")
    timeout: Optional[float] = None
    status_message: Optional[str] = Field(default=None, alias="statusMessage")
    once: Optional[bool] = None


class BashCommandHook(_HookCommandBase):
    type: Literal["command"] = "command"
    command: str
    shell: Optional[Literal["bash", "powershell"]] = None
    async_: Optional[bool] = Field(default=None, alias="async")
    async_rewake: Optional[bool] = Field(default=None, alias="asyncRewake")


class HttpHook(_HookCommandBase):
    """v2 — declared so TS plugin JSON parses, but executor rejects at run time."""

    type: Literal["http"] = "http"
    url: str
    headers: Optional[dict[str, str]] = None
    allowed_env_vars: Optional[list[str]] = Field(default=None, alias="allowedEnvVars")


class PromptHook(_HookCommandBase):
    """v2 — parses but not executed."""

    type: Literal["prompt"] = "prompt"
    prompt: str
    model: Optional[str] = None


class AgentHook(_HookCommandBase):
    """v2 — parses but not executed."""

    type: Literal["agent"] = "agent"
    prompt: str
    model: Optional[str] = None


class CallbackHook(_HookCommandBase):
    """In-process Python callable. Dotted path loaded by importlib.

    Only usable from trusted sources (built-in plugins or managed
    settings). Plugin-authored callback hooks are rejected.
    """

    type: Literal["callback"] = "callback"
    callback: str  # dotted path: "module.sub:func" or "module.sub.func"


HookCommand = Union[BashCommandHook, HttpHook, PromptHook, AgentHook, CallbackHook]


class HookMatcher(BaseModel):
    model_config = _BaseConfig
    matcher: Optional[str] = None
    hooks: list[HookCommand] = Field(default_factory=list)


class HooksSettings(BaseModel):
    """Top-level hooks config — Partial<Record<HookEvent, HookMatcher[]>>.

    Stored as a plain dict[str, list[HookMatcher]] rather than a TypedDict so
    unknown event names (e.g. a future TS event) don't crash parsing.
    """

    model_config = _BaseConfig
    root: dict[str, list[HookMatcher]] = Field(default_factory=dict)

    @classmethod
    def from_raw(cls, raw: Any) -> "HooksSettings":
        if not isinstance(raw, dict):
            return cls()
        parsed: dict[str, list[HookMatcher]] = {}
        for event_key, matchers in raw.items():
            if not isinstance(event_key, str) or not isinstance(matchers, list):
                continue
            items: list[HookMatcher] = []
            for entry in matchers:
                if not isinstance(entry, dict):
                    continue
                try:
                    items.append(HookMatcher.model_validate(entry))
                except Exception:
                    continue
            if items:
                parsed[event_key] = items
        return cls(root=parsed)

    def to_raw(self) -> dict[str, list[dict[str, Any]]]:
        return {
            event: [m.model_dump(by_alias=True, exclude_none=True) for m in matchers]
            for event, matchers in self.root.items()
        }


# ---------------------------------------------------------------------------
# Hook inputs (JSON written to hook stdin)
# ---------------------------------------------------------------------------


class _HookInputBase(BaseModel):
    model_config = _BaseConfig
    hook_event_name: str
    session_id: str
    transcript_path: str = ""
    cwd: str = ""


class PreToolUseHookInput(_HookInputBase):
    hook_event_name: Literal["PreToolUse"] = "PreToolUse"
    permission_mode: Optional[str] = None
    tool_name: str
    tool_input: dict[str, Any] = Field(default_factory=dict)
    tool_use_id: str = ""


class PostToolUseHookInput(_HookInputBase):
    hook_event_name: Literal["PostToolUse"] = "PostToolUse"
    permission_mode: Optional[str] = None
    tool_name: str
    tool_input: dict[str, Any] = Field(default_factory=dict)
    tool_response: Any = None
    tool_use_id: str = ""


class PostToolUseFailureHookInput(_HookInputBase):
    hook_event_name: Literal["PostToolUseFailure"] = "PostToolUseFailure"
    tool_name: str
    tool_input: dict[str, Any] = Field(default_factory=dict)
    tool_use_id: str = ""
    error: str = ""
    is_interrupt: bool = False


class UserPromptSubmitHookInput(_HookInputBase):
    hook_event_name: Literal["UserPromptSubmit"] = "UserPromptSubmit"
    prompt: str = ""


class SessionStartHookInput(_HookInputBase):
    hook_event_name: Literal["SessionStart"] = "SessionStart"
    source: Literal["startup", "resume", "clear", "compact"] = "startup"


class SessionEndHookInput(_HookInputBase):
    hook_event_name: Literal["SessionEnd"] = "SessionEnd"
    reason: Literal["clear", "logout", "other", "errored"] = "other"


class StopHookInput(_HookInputBase):
    hook_event_name: Literal["Stop"] = "Stop"
    stop_hook_active: bool = False
    last_assistant_message: str = ""


class NotificationHookInput(_HookInputBase):
    hook_event_name: Literal["Notification"] = "Notification"
    message: str = ""
    title: Optional[str] = None
    notification_type: Optional[str] = None


# ---------------------------------------------------------------------------
# Hook output (JSON from hook stdout)
# ---------------------------------------------------------------------------


class _HookSpecificOutputBase(BaseModel):
    model_config = _BaseConfig


class PreToolUseHookSpecificOutput(_HookSpecificOutputBase):
    hook_event_name: Literal["PreToolUse"] = Field(default="PreToolUse", alias="hookEventName")
    permission_decision: Optional[Literal["allow", "deny", "ask"]] = Field(
        default=None, alias="permissionDecision"
    )
    permission_decision_reason: Optional[str] = Field(
        default=None, alias="permissionDecisionReason"
    )
    updated_input: Optional[dict[str, Any]] = Field(default=None, alias="updatedInput")
    additional_context: Optional[str] = Field(default=None, alias="additionalContext")


class PostToolUseHookSpecificOutput(_HookSpecificOutputBase):
    hook_event_name: Literal["PostToolUse"] = Field(default="PostToolUse", alias="hookEventName")
    additional_context: Optional[str] = Field(default=None, alias="additionalContext")
    updated_tool_output: Optional[str] = Field(default=None, alias="updatedToolOutput")


class UserPromptSubmitHookSpecificOutput(_HookSpecificOutputBase):
    hook_event_name: Literal["UserPromptSubmit"] = Field(default="UserPromptSubmit", alias="hookEventName")
    additional_context: Optional[str] = Field(default=None, alias="additionalContext")
    updated_input: Optional[str] = Field(default=None, alias="updatedInput")


class SessionStartHookSpecificOutput(_HookSpecificOutputBase):
    hook_event_name: Literal["SessionStart"] = Field(default="SessionStart", alias="hookEventName")
    additional_context: Optional[str] = Field(default=None, alias="additionalContext")
    initial_user_message: Optional[str] = Field(default=None, alias="initialUserMessage")


class SyncHookJSONOutput(BaseModel):
    model_config = _BaseConfig

    continue_: Optional[bool] = Field(default=None, alias="continue")
    suppress_output: Optional[bool] = Field(default=None, alias="suppressOutput")
    stop_reason: Optional[str] = Field(default=None, alias="stopReason")
    decision: Optional[Literal["approve", "block"]] = None
    reason: Optional[str] = None
    system_message: Optional[str] = Field(default=None, alias="systemMessage")
    hook_specific_output: Optional[dict[str, Any]] = Field(
        default=None, alias="hookSpecificOutput"
    )


# ---------------------------------------------------------------------------
# Aggregation result returned to the agent
# ---------------------------------------------------------------------------


class HookResult(BaseModel):
    """Per-hook execution result (one entry per invoked hook)."""

    model_config = _BaseConfig

    outcome: Literal["ok", "blocking", "non_blocking_error", "skipped"]
    hook_type: str
    plugin_id: Optional[str] = None
    matcher: Optional[str] = None
    duration_ms: int = 0
    exit_code: Optional[int] = None
    reason: Optional[str] = None
    stderr_tail: Optional[str] = None
    output: Optional[SyncHookJSONOutput] = None


class AggregatedHookResult(BaseModel):
    """Result of executing all hooks matching an event."""

    model_config = _BaseConfig

    event: str
    permission_behavior: Literal["allow", "ask", "deny"] = "allow"
    prevent_continuation: bool = False
    stop_reason: Optional[str] = None
    decision_reason: Optional[str] = None
    system_messages: list[str] = Field(default_factory=list)
    additional_contexts: list[str] = Field(default_factory=list)
    updated_input: Optional[dict[str, Any]] = None
    updated_tool_output: Optional[str] = None
    initial_user_message: Optional[str] = None
    results: list[HookResult] = Field(default_factory=list)
    blocking_reason: Optional[str] = None

    def any_block(self) -> bool:
        return self.permission_behavior == "deny" or self.prevent_continuation

    @classmethod
    def empty(cls, event: str) -> "AggregatedHookResult":
        return cls(event=event)
