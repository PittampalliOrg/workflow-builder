"""Callback hook executor.

Executes a direct Python callable (for SDK/plugin use).
"""

from __future__ import annotations

import logging
from typing import Any

from ..types import (
    CallbackHookConfig,
    FunctionHookConfig,
    HookBlockingError,
    HookOutcome,
    HookResult,
)

logger = logging.getLogger(__name__)


def exec_callback_hook(
    hook: CallbackHookConfig,
    hook_input: Any,
    tool_use_id: str = "",
) -> HookResult:
    """Execute a callback hook by calling the registered Python callable."""
    try:
        output = hook.callback(hook_input, tool_use_id)
        if isinstance(output, dict):
            from ..helpers import hook_result_from_output

            return hook_result_from_output(output, command_desc="callback")
        return HookResult(outcome=HookOutcome.SUCCESS)
    except Exception as exc:
        logger.warning("Callback hook failed: %s", exc)
        return HookResult(outcome=HookOutcome.NON_BLOCKING_ERROR)


def exec_function_hook(
    hook: FunctionHookConfig,
    messages: list | None = None,
) -> HookResult:
    """Execute a function hook (session-scoped validation).

    Returns blocking error if the callback returns False.
    """
    try:
        ok = hook.callback(messages or [])
        if not ok:
            return HookResult(
                outcome=HookOutcome.BLOCKING,
                blocking_error=HookBlockingError(
                    blocking_error=hook.error_message,
                    command="function",
                ),
                prevent_continuation=True,
                stop_reason=hook.error_message,
            )
        return HookResult(outcome=HookOutcome.SUCCESS)
    except Exception as exc:
        logger.warning("Function hook failed: %s", exc)
        return HookResult(outcome=HookOutcome.NON_BLOCKING_ERROR)
