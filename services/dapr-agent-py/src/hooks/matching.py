"""Hook matching logic.

Ported from claude-code-src/main/utils/hooks.ts matchesPattern (line 1346)
and getMatchingHooks (line 1603).
"""

from __future__ import annotations

import logging
import os
import re
from typing import Sequence

from .types import (
    CallbackHookConfig,
    FunctionHookConfig,
    HookCommand,
    HookEvent,
    HookInput,
    HookMatcher,
    SessionHookMatcher,
)

logger = logging.getLogger(__name__)

# Alphanumeric + underscores + pipes: treated as exact/pipe-separated match
_SIMPLE_PATTERN = re.compile(r"^[a-zA-Z0-9_|]+$")


def matches_pattern(match_query: str, matcher: str) -> bool:
    """Test whether *match_query* matches a hook *matcher* pattern.

    Mirrors ``matchesPattern`` in hooks.ts:

    * Empty or ``*`` → matches everything.
    * Simple alphanumeric with ``|`` → pipe-separated exact match.
    * Otherwise → treated as regex.
    """
    if not matcher or matcher == "*":
        return True

    if _SIMPLE_PATTERN.match(matcher):
        if "|" in matcher:
            patterns = [p.strip() for p in matcher.split("|")]
            return match_query in patterns
        return match_query == matcher

    # Regex fallback
    try:
        return bool(re.search(matcher, match_query))
    except re.error:
        logger.debug("Invalid regex in hook matcher: %s", matcher)
        return False


def check_if_condition(if_condition: str, hook_input: HookInput) -> bool:
    """Evaluate an ``if`` condition string against hook input.

    The TS system uses permission-rule syntax like ``Bash(git *)``.
    We implement a simplified version:

    * Empty condition → always True.
    * ``ToolName`` → matches tool_name exactly.
    * ``ToolName(pattern)`` → matches tool_name and first-arg pattern.
    """
    if not if_condition:
        return True

    # Parse "ToolName(pattern)" syntax
    paren_match = re.match(r"^(\w+)\((.+)\)$", if_condition)
    if paren_match:
        tool_name_cond = paren_match.group(1)
        arg_pattern = paren_match.group(2)
        input_tool = getattr(hook_input, "tool_name", "")
        if input_tool != tool_name_cond:
            return False
        # Check arg pattern against serialized tool_input
        tool_input = getattr(hook_input, "tool_input", {})
        if isinstance(tool_input, dict):
            # For Bash-style: match against the "command" arg
            cmd = str(tool_input.get("command", ""))
            try:
                # Convert glob-like pattern to regex
                regex_pat = arg_pattern.replace("*", ".*")
                return bool(re.match(regex_pat, cmd))
            except re.error:
                return False
        return False

    # Simple tool name match
    input_tool = getattr(hook_input, "tool_name", "")
    return input_tool == if_condition


def get_match_query(hook_event: HookEvent, hook_input: HookInput) -> str:
    """Determine the match query string for a given hook event.

    Mirrors the event-to-matchQuery mapping in getMatchingHooks.
    """
    # Tool events: match on tool_name
    if hook_event in (
        HookEvent.PRE_TOOL_USE,
        HookEvent.POST_TOOL_USE,
        HookEvent.POST_TOOL_USE_FAILURE,
        HookEvent.PERMISSION_REQUEST,
        HookEvent.PERMISSION_DENIED,
    ):
        return getattr(hook_input, "tool_name", "")

    # Session events
    if hook_event == HookEvent.SESSION_START:
        return getattr(hook_input, "source", "")
    if hook_event == HookEvent.SESSION_END:
        return getattr(hook_input, "reason", "")

    # Setup/compact
    if hook_event in (HookEvent.SETUP, HookEvent.PRE_COMPACT, HookEvent.POST_COMPACT):
        return getattr(hook_input, "trigger", "")

    # Notification
    if hook_event == HookEvent.NOTIFICATION:
        return getattr(hook_input, "notification_type", "")

    # Subagent
    if hook_event in (HookEvent.SUBAGENT_START, HookEvent.SUBAGENT_STOP):
        return getattr(hook_input, "agent_type", "")

    # Elicitation
    if hook_event in (HookEvent.ELICITATION, HookEvent.ELICITATION_RESULT):
        return getattr(hook_input, "mcp_server_name", "")

    # Config/instructions
    if hook_event == HookEvent.CONFIG_CHANGE:
        return getattr(hook_input, "source", "")
    if hook_event == HookEvent.INSTRUCTIONS_LOADED:
        return getattr(hook_input, "load_reason", "")

    # File changed: match on basename
    if hook_event == HookEvent.FILE_CHANGED:
        path = getattr(hook_input, "file_path", "")
        return os.path.basename(path) if path else ""

    # Stop failure
    if hook_event == HookEvent.STOP_FAILURE:
        return getattr(hook_input, "error", "")

    # Events with no specific match query (match all)
    return ""


def get_matching_hooks(
    hook_event: HookEvent,
    hook_input: HookInput,
    settings_matchers: Sequence[HookMatcher],
    registered_matchers: Sequence[HookMatcher],
    session_matchers: Sequence[SessionHookMatcher],
    match_query: str | None = None,
) -> list[tuple[HookCommand | CallbackHookConfig | FunctionHookConfig, HookMatcher | SessionHookMatcher]]:
    """Return all hooks matching the event and query.

    Returns list of (hook_config, parent_matcher) tuples.
    Priority: settings > registered (plugin) > session.
    """
    if match_query is None:
        match_query = get_match_query(hook_event, hook_input)

    matched: list[tuple[HookCommand | CallbackHookConfig | FunctionHookConfig, HookMatcher | SessionHookMatcher]] = []

    # Collect from all sources in priority order
    all_matchers: list[tuple[HookMatcher | SessionHookMatcher, str]] = []
    for m in settings_matchers:
        all_matchers.append((m, "settings"))
    for m in registered_matchers:
        all_matchers.append((m, "registered"))
    for m in session_matchers:
        all_matchers.append((m, "session"))

    for matcher, _source in all_matchers:
        pattern = matcher.matcher if hasattr(matcher, "matcher") else ""
        if match_query and not matches_pattern(match_query, pattern):
            continue

        hooks = matcher.hooks
        for hook in hooks:
            # Check if-condition
            if_cond = getattr(hook, "if_condition", "")
            if if_cond and not check_if_condition(if_cond, hook_input):
                continue
            matched.append((hook, matcher))

    return matched
