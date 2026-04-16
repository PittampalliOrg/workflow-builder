"""Hook helper utilities.

Ported from claude-code-src/main/utils/hooks/hookHelpers.ts.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict
from typing import Any

from .types import (
    HookBlockingError,
    HookInput,
    HookOutcome,
    HookResult,
)

logger = logging.getLogger(__name__)


def hook_input_to_json(hook_input: HookInput) -> str:
    """Serialize a HookInput dataclass to JSON string."""
    raw = asdict(hook_input)
    # Convert enum values to their string representation
    if "hook_event_name" in raw and hasattr(raw["hook_event_name"], "value"):
        raw["hook_event_name"] = raw["hook_event_name"]
    return json.dumps(raw, default=str)


def add_arguments_to_prompt(prompt: str, hook_input_json: str) -> str:
    """Replace $ARGUMENTS placeholder in prompt with JSON input.

    Mirrors hookHelpers.ts:addArgumentsToPrompt.
    """
    return prompt.replace("$ARGUMENTS", hook_input_json)


def parse_hook_json_output(raw: str) -> dict[str, Any]:
    """Parse hook stdout as JSON.  Returns empty dict on failure."""
    if not raw or not raw.strip():
        return {}
    try:
        result = json.loads(raw.strip())
        if isinstance(result, dict):
            return result
    except json.JSONDecodeError:
        logger.debug("Hook output is not valid JSON: %s", raw[:200])
    return {}


def hook_result_from_output(
    output: dict[str, Any],
    command_desc: str,
    exit_code: int = 0,
) -> HookResult:
    """Build a HookResult from parsed JSON output and exit code.

    Mirrors the result-processing logic in hooks.ts executeHooks.
    Exit codes: 0 = success, 2 = blocking error, other = non-blocking error.
    """
    result = HookResult()

    # Exit code semantics (same as TS)
    if exit_code == 2:
        error_msg = output.get("stopReason") or output.get("reason") or "Blocked by hook"
        result.outcome = HookOutcome.BLOCKING
        result.blocking_error = HookBlockingError(
            blocking_error=error_msg,
            command=command_desc,
        )
        result.prevent_continuation = True
        result.stop_reason = error_msg
        return result

    if exit_code != 0:
        result.outcome = HookOutcome.NON_BLOCKING_ERROR
        return result

    # Process continue flag
    if output.get("continue") is False:
        stop_reason = output.get("stopReason") or output.get("reason") or "Stopped by hook"
        result.outcome = HookOutcome.BLOCKING
        result.blocking_error = HookBlockingError(
            blocking_error=stop_reason,
            command=command_desc,
        )
        result.prevent_continuation = True
        result.stop_reason = stop_reason
        return result

    # Process hookSpecificOutput
    specific = output.get("hookSpecificOutput", {})
    if isinstance(specific, dict):
        # Permission decision
        decision = specific.get("permissionDecision") or specific.get("decision")
        if decision in ("approve", "allow"):
            result.permission_behavior = "allow"
        elif decision == "block" or decision == "deny":
            result.permission_behavior = "deny"

        result.permission_decision_reason = str(
            specific.get("permissionDecisionReason") or specific.get("reason") or ""
        )
        result.additional_context = str(specific.get("additionalContext") or "")
        result.initial_user_message = str(specific.get("initialUserMessage") or "")

        updated = specific.get("updatedInput")
        if isinstance(updated, dict):
            result.updated_input = updated

        mcp_output = specific.get("updatedMCPToolOutput")
        if mcp_output is not None:
            result.updated_mcp_tool_output = mcp_output

        if specific.get("retry"):
            result.retry = True

        watch = specific.get("watchPaths")
        if isinstance(watch, list):
            result.watch_paths = [str(p) for p in watch]

    # Top-level fields
    if output.get("systemMessage"):
        result.system_message = str(output["systemMessage"])

    if output.get("decision") in ("approve", "allow"):
        result.permission_behavior = "allow"
    elif output.get("decision") in ("block", "deny"):
        result.permission_behavior = "deny"

    if output.get("reason") and not result.permission_decision_reason:
        result.permission_decision_reason = str(output["reason"])

    result.outcome = HookOutcome.SUCCESS
    return result


def get_hook_display_text(hook: Any) -> str:
    """Return a human-readable description of a hook config."""
    hook_type = getattr(hook, "type", "unknown")
    if hook_type == "command":
        cmd = getattr(hook, "command", "")
        return f"command: {cmd[:80]}"
    if hook_type == "prompt":
        prompt = getattr(hook, "prompt", "")
        return f"prompt: {prompt[:80]}"
    if hook_type == "agent":
        prompt = getattr(hook, "prompt", "")
        return f"agent: {prompt[:80]}"
    if hook_type == "http":
        url = getattr(hook, "url", "")
        return f"http: {url}"
    if hook_type == "callback":
        return "callback"
    if hook_type == "function":
        return "function"
    return f"unknown({hook_type})"
