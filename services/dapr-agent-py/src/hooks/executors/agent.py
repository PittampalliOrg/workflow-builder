"""Agent hook executor.

Ported from claude-code-src/main/utils/hooks/execAgentHook.ts.

Spawns a multi-turn LLM agent to verify a condition.  The agent has
access to tools and must return a structured ``{ok, reason}`` verdict.
"""

from __future__ import annotations

import logging
from typing import Any

from ..helpers import add_arguments_to_prompt
from ..types import (
    AgentHookConfig,
    HookBlockingError,
    HookOutcome,
    HookResult,
)

logger = logging.getLogger(__name__)


def exec_agent_hook(
    hook: AgentHookConfig,
    input_json: str,
    *,
    agent_callable: Any | None = None,
) -> HookResult:
    """Execute an agent hook by running a multi-turn verification agent.

    *agent_callable* should accept a prompt string and return a dict with
    ``ok: bool`` and optional ``reason: str``.  If not provided the hook
    is skipped.
    """
    if agent_callable is None:
        logger.debug("Agent hook skipped — no agent callable configured")
        return HookResult(outcome=HookOutcome.SUCCESS)

    prompt = add_arguments_to_prompt(hook.prompt, input_json)

    try:
        response = agent_callable(prompt)
    except Exception as exc:
        logger.warning("Agent hook failed: %s", exc)
        return HookResult(outcome=HookOutcome.NON_BLOCKING_ERROR)

    if not isinstance(response, dict):
        return HookResult(outcome=HookOutcome.SUCCESS)

    ok = response.get("ok", True)
    reason = str(response.get("reason", ""))

    if not ok:
        return HookResult(
            outcome=HookOutcome.BLOCKING,
            blocking_error=HookBlockingError(
                blocking_error=reason or "Blocked by agent hook",
                command=f"agent: {hook.prompt[:80]}",
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
