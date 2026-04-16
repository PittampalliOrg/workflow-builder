"""Core hook execution engine.

Ported from claude-code-src/main/utils/hooks.ts executeHooks (line 1952).

Orchestrates parallel execution of matched hooks via ThreadPoolExecutor,
then aggregates results.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from .helpers import (
    get_hook_display_text,
    hook_input_to_json,
)
from .matching import get_matching_hooks
from .registry import get_hook_registry
from .types import (
    AggregatedHookResult,
    AgentHookConfig,
    CallbackHookConfig,
    CommandHookConfig,
    FunctionHookConfig,
    HookCommand,
    HookEvent,
    HookInput,
    HookMatcher,
    HookOutcome,
    HookResult,
    HttpHookConfig,
    PromptHookConfig,
    SessionHookMatcher,
)

logger = logging.getLogger(__name__)

# Max parallel hook threads (mirrors TS Promise.all behavior)
_MAX_WORKERS = 8

# Default timeout for hook execution (ms)
DEFAULT_HOOK_TIMEOUT_MS = 600_000  # 10 minutes


def _execute_single_hook(
    hook: HookCommand | CallbackHookConfig | FunctionHookConfig,
    input_json: str,
    hook_input: HookInput,
    matcher: HookMatcher | SessionHookMatcher,
) -> HookResult:
    """Dispatch a single hook to the appropriate executor."""
    hook_type = getattr(hook, "type", "")

    if hook_type == "command":
        from .executors.command import exec_command_hook

        assert isinstance(hook, CommandHookConfig)

        # Build env overrides for plugin hooks
        env: dict[str, str] = {}
        if isinstance(matcher, HookMatcher) and matcher.plugin_root:
            env["CLAUDE_PLUGIN_ROOT"] = matcher.plugin_root

        # Async command hooks: fire-and-forget
        if hook.async_:
            from .executors.command import exec_command_hook_async

            exec_command_hook_async(hook, input_json, env_overrides=env or None)
            return HookResult(outcome=HookOutcome.SUCCESS)

        return exec_command_hook(hook, input_json, env_overrides=env or None)

    if hook_type == "http":
        from .executors.http import exec_http_hook

        assert isinstance(hook, HttpHookConfig)
        return exec_http_hook(hook, input_json)

    if hook_type == "prompt":
        from .executors.prompt import exec_prompt_hook

        assert isinstance(hook, PromptHookConfig)
        return exec_prompt_hook(hook, input_json)

    if hook_type == "agent":
        from .executors.agent import exec_agent_hook

        assert isinstance(hook, AgentHookConfig)
        return exec_agent_hook(hook, input_json)

    if hook_type == "callback":
        from .executors.callback import exec_callback_hook

        assert isinstance(hook, CallbackHookConfig)
        return exec_callback_hook(hook, hook_input)

    if hook_type == "function":
        from .executors.callback import exec_function_hook

        assert isinstance(hook, FunctionHookConfig)
        return exec_function_hook(hook)

    logger.debug("Unknown hook type: %s", hook_type)
    return HookResult(outcome=HookOutcome.NON_BLOCKING_ERROR)


def _aggregate_results(results: list[HookResult]) -> AggregatedHookResult:
    """Combine individual hook results into an aggregated result.

    Permission behavior precedence: deny > ask > allow > passthrough
    (mirrors hooks.ts lines 2820-2847).
    """
    agg = AggregatedHookResult()

    _PERM_PRIORITY = {"deny": 4, "ask": 3, "allow": 2, "passthrough": 1, "": 0}
    best_perm_priority = 0

    for r in results:
        # Blocking errors
        if r.blocking_error:
            agg.blocking_errors.append(r.blocking_error)

        if r.prevent_continuation:
            agg.prevent_continuation = True
            if r.stop_reason and not agg.stop_reason:
                agg.stop_reason = r.stop_reason

        # Permission behavior (highest priority wins)
        perm_priority = _PERM_PRIORITY.get(r.permission_behavior, 0)
        if perm_priority > best_perm_priority:
            best_perm_priority = perm_priority
            agg.permission_behavior = r.permission_behavior
            agg.permission_decision_reason = r.permission_decision_reason

        # Additional context
        if r.additional_context:
            agg.additional_contexts.append(r.additional_context)

        # Initial user message (first one wins)
        if r.initial_user_message and not agg.initial_user_message:
            agg.initial_user_message = r.initial_user_message

        # Updated input (last one wins — matches TS behavior)
        if r.updated_input is not None:
            agg.updated_input = r.updated_input

        # Updated MCP tool output
        if r.updated_mcp_tool_output is not None:
            agg.updated_mcp_tool_output = r.updated_mcp_tool_output

        # Retry
        if r.retry:
            agg.retry = True

        # Messages
        if r.message:
            agg.messages.append(r.message)

        # Watch paths
        if r.watch_paths:
            agg.watch_paths.extend(r.watch_paths)

    return agg


def execute_hooks(
    hook_event: HookEvent,
    hook_input: HookInput,
    session_id: str = "",
    match_query: str | None = None,
    timeout_ms: int = DEFAULT_HOOK_TIMEOUT_MS,
) -> AggregatedHookResult:
    """Execute all matching hooks for an event in parallel.

    This is the main entry point, equivalent to ``executeHooks`` in hooks.ts.

    Returns an ``AggregatedHookResult`` with combined blocking errors,
    updated inputs, permission decisions, and additional context.
    """
    registry = get_hook_registry()

    # Early exit: no hooks registered for this event
    if not registry.has_hooks_for_event(session_id, hook_event):
        return AggregatedHookResult()

    # Gather matchers from all sources
    settings_matchers, registered_matchers, session_matchers = registry.get_all_for_event(
        session_id, hook_event
    )

    # Find matching hooks
    matched = get_matching_hooks(
        hook_event=hook_event,
        hook_input=hook_input,
        settings_matchers=settings_matchers,
        registered_matchers=registered_matchers,
        session_matchers=session_matchers,
        match_query=match_query,
    )

    if not matched:
        return AggregatedHookResult()

    # Serialize input once for all hooks
    input_json = hook_input_to_json(hook_input)

    # Fast path: single hook, run inline
    if len(matched) == 1:
        hook, matcher = matched[0]
        logger.debug(
            "Executing single %s hook: %s",
            hook_event.value,
            get_hook_display_text(hook),
        )
        result = _execute_single_hook(hook, input_json, hook_input, matcher)
        agg = _aggregate_results([result])

        # Handle 'once' hooks
        if getattr(hook, "once", False) and result.outcome == HookOutcome.SUCCESS:
            _remove_once_hook(hook, matcher, session_id)

        # Invoke session hook success callback
        if (
            result.outcome == HookOutcome.SUCCESS
            and isinstance(matcher, SessionHookMatcher)
            and matcher.on_hook_success
        ):
            try:
                matcher.on_hook_success()
            except Exception:
                logger.debug("Session hook success callback failed", exc_info=True)

        return agg

    # Parallel execution
    logger.debug(
        "Executing %d %s hooks in parallel",
        len(matched),
        hook_event.value,
    )

    results: list[HookResult] = []
    with ThreadPoolExecutor(max_workers=min(len(matched), _MAX_WORKERS)) as pool:
        futures = {
            pool.submit(_execute_single_hook, hook, input_json, hook_input, matcher): (hook, matcher)
            for hook, matcher in matched
        }
        for future in as_completed(futures):
            hook, matcher = futures[future]
            try:
                result = future.result(timeout=timeout_ms / 1000)
            except Exception as exc:
                logger.warning(
                    "Hook execution failed: %s — %s",
                    get_hook_display_text(hook),
                    exc,
                )
                result = HookResult(outcome=HookOutcome.NON_BLOCKING_ERROR)

            results.append(result)

            # Handle 'once' hooks
            if getattr(hook, "once", False) and result.outcome == HookOutcome.SUCCESS:
                _remove_once_hook(hook, matcher, session_id)

            # Session hook success callback
            if (
                result.outcome == HookOutcome.SUCCESS
                and isinstance(matcher, SessionHookMatcher)
                and matcher.on_hook_success
            ):
                try:
                    matcher.on_hook_success()
                except Exception:
                    logger.debug("Session hook success callback failed", exc_info=True)

    return _aggregate_results(results)


def _remove_once_hook(
    hook: Any,
    matcher: HookMatcher | SessionHookMatcher,
    session_id: str,
) -> None:
    """Remove a ``once=True`` hook after successful execution."""
    try:
        if isinstance(matcher, SessionHookMatcher):
            # Remove from session hooks
            matcher.hooks = [h for h in matcher.hooks if h is not hook]
        # For settings/registered hooks, removal is best-effort
        # (the hook won't match again after removal from the matcher)
        elif isinstance(matcher, HookMatcher):
            matcher.hooks = [h for h in matcher.hooks if h is not hook]
    except Exception:
        logger.debug("Failed to remove once-hook", exc_info=True)
