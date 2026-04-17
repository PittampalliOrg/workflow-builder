"""Execute matched hooks for an event and aggregate results.

Runs all matching hooks in parallel. Applies per-hook `if`-rule pre-filter
for PreToolUse / PostToolUse / PostToolUseFailure (the events where `if`
is meaningful, matching tool_name + tool_input against permission-rule
syntax).

Aggregation:
    decision precedence: deny > ask > allow
    prevent_continuation: any hook outputs decision=="block" or continue==false
    updated_input:        first PreToolUse hook_specific_output.updatedInput wins
    additional_contexts:  concatenated across hooks
    system_messages:      concatenated across hooks
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Optional

from . import permission_rules
from .callback_runner import CallbackContext, run_callback_hook
from .events import HookEvent, V1_EMITTED_EVENTS
from .registry import HooksSnapshot, MatchingHook
from .schemas import (
    AggregatedHookResult,
    BashCommandHook,
    CallbackHook,
    HookResult,
    SyncHookJSONOutput,
)
from .subprocess_runner import (
    DEFAULT_HOOK_TIMEOUT_MS,
    RunnerContext,
    run_command_hook,
)

logger = logging.getLogger(__name__)


_EVENTS_WITH_IF_FILTER = {
    HookEvent.PreToolUse.value,
    HookEvent.PostToolUse.value,
    HookEvent.PostToolUseFailure.value,
}


def _if_filter_passes(event: str, if_rule: Optional[str], hook_input: dict[str, Any]) -> bool:
    if not if_rule:
        return True
    if event not in _EVENTS_WITH_IF_FILTER:
        return True
    tool_name = str(hook_input.get("tool_name") or "")
    tool_input = hook_input.get("tool_input") if isinstance(hook_input.get("tool_input"), dict) else {}
    try:
        return permission_rules.evaluate(if_rule, tool_name, tool_input)  # type: ignore[arg-type]
    except Exception as exc:
        logger.warning("[hooks] if-rule eval failed (%s): %s", if_rule, exc)
        return True  # defensive: run the hook rather than silently skip


async def _dispatch(
    matched: MatchingHook,
    hook_input: dict[str, Any],
    runner_ctx: RunnerContext,
) -> HookResult:
    hook = matched.hook
    matcher = matched.registered.matcher or None
    plugin_id = matched.registered.plugin_id
    if isinstance(hook, BashCommandHook):
        scoped = runner_ctx
        if matched.registered.plugin_root:
            scoped = RunnerContext(
                project_dir=runner_ctx.project_dir,
                plugin_root=matched.registered.plugin_root,
                plugin_data=runner_ctx.plugin_data,
                plugin_options=runner_ctx.plugin_options,
                default_timeout_ms=runner_ctx.default_timeout_ms,
                env_extra=runner_ctx.env_extra,
            )
        return await run_command_hook(
            hook,
            hook_input,
            scoped,
            plugin_id=plugin_id,
            matcher=matcher,
        )
    if isinstance(hook, CallbackHook):
        if matched.registered.source == "plugin":
            return HookResult(
                outcome="skipped",
                hook_type="callback",
                plugin_id=plugin_id,
                matcher=matcher,
                reason="plugin-provided callback hooks are not executed",
            )
        ctx = CallbackContext(
            project_dir=runner_ctx.project_dir,
            plugin_id=plugin_id,
            plugin_root=matched.registered.plugin_root,
        )
        return await run_callback_hook(hook, hook_input, ctx, matcher=matcher)
    # http / prompt / agent — v1 declared but not executed
    return HookResult(
        outcome="skipped",
        hook_type=getattr(hook, "type", "unknown"),
        plugin_id=plugin_id,
        matcher=matcher,
        reason=f"hook type '{getattr(hook, 'type', '?')}' not supported in v1",
    )


def _aggregate(event: str, results: list[HookResult]) -> AggregatedHookResult:
    agg = AggregatedHookResult(event=event, results=results)
    decision_ranks = {"allow": 0, "ask": 1, "deny": 2}
    current_rank = 0
    for r in results:
        out = r.output
        if r.outcome == "blocking":
            agg.prevent_continuation = True
            if not agg.blocking_reason:
                agg.blocking_reason = r.reason
                agg.decision_reason = r.reason
            # Blocking outcome implies permission deny for PreToolUse-like events.
            current_rank = max(current_rank, decision_ranks["deny"])
        if out is None:
            continue
        if out.continue_ is False:
            agg.prevent_continuation = True
            if out.stop_reason:
                agg.stop_reason = out.stop_reason
            if not agg.blocking_reason and out.reason:
                agg.blocking_reason = out.reason
        if out.decision == "block":
            agg.prevent_continuation = True
            if not agg.blocking_reason:
                agg.blocking_reason = out.reason or "blocked by hook"
            current_rank = max(current_rank, decision_ranks["deny"])
        if out.system_message:
            agg.system_messages.append(out.system_message)
        spec = out.hook_specific_output or {}
        perm = spec.get("permissionDecision")
        if isinstance(perm, str) and perm in decision_ranks:
            current_rank = max(current_rank, decision_ranks[perm])
            if perm == "deny" and not agg.decision_reason:
                agg.decision_reason = spec.get("permissionDecisionReason") or out.reason
        additional = spec.get("additionalContext")
        if isinstance(additional, str) and additional:
            agg.additional_contexts.append(additional)
        updated_input = spec.get("updatedInput")
        if isinstance(updated_input, dict) and agg.updated_input is None:
            agg.updated_input = updated_input
        elif isinstance(updated_input, str) and agg.initial_user_message is None and event == HookEvent.UserPromptSubmit.value:
            # TS allows updatedInput to be a string for UserPromptSubmit.
            agg.initial_user_message = updated_input
        updated_output = spec.get("updatedToolOutput")
        if isinstance(updated_output, str) and agg.updated_tool_output is None:
            agg.updated_tool_output = updated_output
        initial_user = spec.get("initialUserMessage")
        if isinstance(initial_user, str) and agg.initial_user_message is None:
            agg.initial_user_message = initial_user

    for rank_name, rank in decision_ranks.items():
        if rank == current_rank:
            agg.permission_behavior = rank_name  # type: ignore[assignment]
            break
    return agg


def hooks_enabled() -> bool:
    return os.environ.get("DAPR_AGENT_PY_HOOKS_ENABLED", "false").lower() in {"1", "true", "yes"}


def event_allowed(event: HookEvent | str) -> bool:
    value = event.value if isinstance(event, HookEvent) else event
    allowed = os.environ.get("DAPR_AGENT_PY_HOOKS_EVENTS")
    if not allowed:
        return True
    try:
        import json

        parsed = json.loads(allowed)
    except Exception:
        return True
    if not isinstance(parsed, list):
        return True
    return value in {str(x) for x in parsed}


async def execute_hooks(
    event: HookEvent | str,
    hook_input: dict[str, Any],
    snapshot: HooksSnapshot,
    *,
    match_query: str = "",
    runner_ctx: Optional[RunnerContext] = None,
    default_timeout_ms: int = DEFAULT_HOOK_TIMEOUT_MS,
) -> AggregatedHookResult:
    event_value = event.value if isinstance(event, HookEvent) else event

    if not hooks_enabled() or not event_allowed(event_value):
        return AggregatedHookResult.empty(event_value)

    matches = snapshot.get_matching_hooks(event_value, match_query)
    # `if`-field prefilter
    filtered = [
        m for m in matches
        if _if_filter_passes(event_value, m.hook.if_, hook_input)
    ]
    if not filtered:
        return AggregatedHookResult.empty(event_value)

    if event_value not in {e.value for e in V1_EMITTED_EVENTS}:
        # Registered but never emitted in v1; defensive no-op.
        return AggregatedHookResult.empty(event_value)

    ctx = runner_ctx or RunnerContext(
        project_dir=os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd(),
        default_timeout_ms=default_timeout_ms,
    )

    # claude_code.hook span (beta tracing only — matches TS isBetaTracingEnabled gate).
    # Records event, number of hooks, and an outcome breakdown on end.
    hook_span = None
    try:
        import json as _json

        from src.telemetry import end_hook_span, start_hook_span

        hook_definitions = _json.dumps(
            [
                {
                    "matcher": getattr(m.hook, "matcher", None),
                    "type": getattr(m.hook, "type", None),
                    "source": getattr(m, "source", None),
                }
                for m in filtered
            ]
        )
        hook_span = start_hook_span(
            hook_event=event_value,
            hook_name=f"{event_value}:{match_query}" if match_query else event_value,
            num_hooks=len(filtered),
            hook_definitions=hook_definitions,
        )
    except Exception:  # noqa: BLE001
        hook_span = None

    try:
        results = await asyncio.gather(
            *(_dispatch(m, hook_input, ctx) for m in filtered),
            return_exceptions=False,
        )
    except Exception:
        if hook_span is not None:
            try:
                end_hook_span(
                    hook_span,
                    num_success=0,
                    num_non_blocking_error=len(filtered),
                )
            except Exception:
                pass
        raise
    agg = _aggregate(event_value, list(results))
    if hook_span is not None:
        try:
            end_hook_span(
                hook_span,
                num_success=sum(1 for r in results if getattr(r, "ok", False)),
                num_blocking=sum(
                    1 for r in results if getattr(r, "blocking", False)
                ),
                num_non_blocking_error=sum(
                    1
                    for r in results
                    if not getattr(r, "ok", False)
                    and not getattr(r, "blocking", False)
                ),
                num_cancelled=sum(
                    1 for r in results if getattr(r, "cancelled", False)
                ),
            )
        except Exception:
            pass
    return agg


__all__ = ["execute_hooks", "hooks_enabled", "event_allowed"]
