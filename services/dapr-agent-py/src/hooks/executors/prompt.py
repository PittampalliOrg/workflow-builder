"""Prompt hook executor.

Ported from claude-code-src/main/utils/hooks/execPromptHook.ts.

Uses an LLM to evaluate a condition.  The prompt's $ARGUMENTS placeholder
is replaced with the JSON hook input.
"""

from __future__ import annotations

import logging
from typing import Any

from ..helpers import add_arguments_to_prompt
from ..types import (
    HookBlockingError,
    HookOutcome,
    HookResult,
    PromptHookConfig,
)

logger = logging.getLogger(__name__)


def exec_prompt_hook(
    hook: PromptHookConfig,
    input_json: str,
    *,
    llm_callable: Any | None = None,
) -> HookResult:
    """Execute a prompt hook by querying an LLM.

    *llm_callable* should accept a string prompt and return a dict with
    ``ok: bool`` and optional ``reason: str``.  If not provided the hook
    is skipped.
    """
    if llm_callable is None:
        logger.debug("Prompt hook skipped — no LLM callable configured")
        return HookResult(outcome=HookOutcome.SUCCESS)

    prompt = add_arguments_to_prompt(hook.prompt, input_json)

    try:
        response = llm_callable(prompt)
    except Exception as exc:
        logger.warning("Prompt hook LLM call failed: %s", exc)
        return HookResult(outcome=HookOutcome.NON_BLOCKING_ERROR)

    if not isinstance(response, dict):
        return HookResult(outcome=HookOutcome.SUCCESS)

    ok = response.get("ok", True)
    reason = str(response.get("reason", ""))

    if not ok:
        return HookResult(
            outcome=HookOutcome.BLOCKING,
            blocking_error=HookBlockingError(
                blocking_error=reason or "Blocked by prompt hook",
                command=f"prompt: {hook.prompt[:80]}",
            ),
            prevent_continuation=True,
            stop_reason=reason,
        )

    if reason:
        return HookResult(
            outcome=HookOutcome.SUCCESS,
            additional_context=reason,
        )

    return HookResult(outcome=HookOutcome.SUCCESS)
