"""Hook configuration loading.

Ported from claude-code-src/main/utils/hooks/hooksConfigSnapshot.ts.

Loads hooks from settings JSON files and converts them to typed
``HookMatcher`` / ``HookCommand`` dataclasses.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from .types import (
    AgentHookConfig,
    CommandHookConfig,
    HookCommand,
    HookEvent,
    HookMatcher,
    HttpHookConfig,
    PromptHookConfig,
)

logger = logging.getLogger(__name__)

# Optional override for the settings file path
HOOKS_CONFIG_PATH_ENV = "HOOKS_CONFIG_PATH"


def _parse_hook_command(raw: dict[str, Any]) -> HookCommand | None:
    """Parse a single hook command dict into a typed config dataclass."""
    hook_type = raw.get("type", "")

    if hook_type == "command":
        return CommandHookConfig(
            command=str(raw.get("command", "")),
            if_condition=str(raw.get("if", "")),
            shell=str(raw.get("shell", "bash")),
            timeout=int(raw.get("timeout", 0)),
            status_message=str(raw.get("statusMessage", "")),
            once=bool(raw.get("once", False)),
            async_=bool(raw.get("async", False)),
            async_rewake=bool(raw.get("asyncRewake", False)),
        )

    if hook_type == "prompt":
        return PromptHookConfig(
            prompt=str(raw.get("prompt", "")),
            if_condition=str(raw.get("if", "")),
            timeout=int(raw.get("timeout", 0)),
            model=str(raw.get("model", "")),
            status_message=str(raw.get("statusMessage", "")),
            once=bool(raw.get("once", False)),
        )

    if hook_type == "agent":
        return AgentHookConfig(
            prompt=str(raw.get("prompt", "")),
            if_condition=str(raw.get("if", "")),
            timeout=int(raw.get("timeout", 60)),
            model=str(raw.get("model", "")),
            status_message=str(raw.get("statusMessage", "")),
            once=bool(raw.get("once", False)),
        )

    if hook_type == "http":
        headers = raw.get("headers", {})
        if not isinstance(headers, dict):
            headers = {}
        allowed_env = raw.get("allowedEnvVars", ())
        if isinstance(allowed_env, list):
            allowed_env = tuple(allowed_env)
        return HttpHookConfig(
            url=str(raw.get("url", "")),
            if_condition=str(raw.get("if", "")),
            timeout=int(raw.get("timeout", 0)),
            headers={str(k): str(v) for k, v in headers.items()},
            allowed_env_vars=allowed_env,
            status_message=str(raw.get("statusMessage", "")),
            once=bool(raw.get("once", False)),
        )

    logger.debug("Unknown hook type: %s", hook_type)
    return None


def _parse_hook_matcher(raw: dict[str, Any]) -> HookMatcher | None:
    """Parse a matcher + hooks dict."""
    raw_hooks = raw.get("hooks", [])
    if not isinstance(raw_hooks, list):
        return None

    hooks: list[HookCommand] = []
    for rh in raw_hooks:
        if not isinstance(rh, dict):
            continue
        parsed = _parse_hook_command(rh)
        if parsed is not None:
            hooks.append(parsed)

    if not hooks:
        return None

    return HookMatcher(
        matcher=str(raw.get("matcher", "")),
        hooks=hooks,
    )


def parse_hooks_settings(
    raw_settings: dict[str, Any],
) -> dict[HookEvent, list[HookMatcher]]:
    """Parse a full ``hooks`` section from settings JSON.

    Expected format::

        {
            "PreToolUse": [ { "matcher": "...", "hooks": [...] }, ... ],
            ...
        }
    """
    result: dict[HookEvent, list[HookMatcher]] = {}

    for event_name, matchers_raw in raw_settings.items():
        # Validate event name
        try:
            event = HookEvent(event_name)
        except ValueError:
            logger.debug("Unknown hook event in settings: %s", event_name)
            continue

        if not isinstance(matchers_raw, list):
            continue

        matchers: list[HookMatcher] = []
        for mr in matchers_raw:
            if not isinstance(mr, dict):
                continue
            parsed = _parse_hook_matcher(mr)
            if parsed is not None:
                matchers.append(parsed)

        if matchers:
            result[event] = matchers

    return result


def load_hooks_from_file(path: str | Path) -> dict[HookEvent, list[HookMatcher]]:
    """Load and parse hooks from a single settings JSON file.

    The file should have a top-level ``hooks`` key.
    """
    path = Path(path)
    if not path.is_file():
        return {}

    try:
        with open(path) as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Failed to load hooks config from %s: %s", path, exc)
        return {}

    hooks_section = data.get("hooks", {})
    if not isinstance(hooks_section, dict):
        return {}

    return parse_hooks_settings(hooks_section)


def load_hooks_from_all_settings() -> dict[HookEvent, list[HookMatcher]]:
    """Load hooks from all settings sources in priority order.

    Sources (highest priority first):
    1. ``HOOKS_CONFIG_PATH`` environment variable
    2. User settings (``~/.claude/settings.json``)
    3. Project settings (``.claude/settings.json``)
    4. Local settings (``.claude/settings.local.json``)

    Later sources do NOT override earlier ones — all hooks are merged.
    """
    merged: dict[HookEvent, list[HookMatcher]] = {}

    # Custom config path (highest priority)
    custom_path = os.environ.get(HOOKS_CONFIG_PATH_ENV)
    if custom_path:
        for event, matchers in load_hooks_from_file(custom_path).items():
            merged.setdefault(event, []).extend(matchers)

    # User settings
    user_settings = Path.home() / ".claude" / "settings.json"
    for event, matchers in load_hooks_from_file(user_settings).items():
        merged.setdefault(event, []).extend(matchers)

    # Project settings
    project_settings = Path(".claude") / "settings.json"
    for event, matchers in load_hooks_from_file(project_settings).items():
        merged.setdefault(event, []).extend(matchers)

    # Local settings
    local_settings = Path(".claude") / "settings.local.json"
    for event, matchers in load_hooks_from_file(local_settings).items():
        merged.setdefault(event, []).extend(matchers)

    return merged
