"""In-process Python callback runner.

Used by built-in hooks only — callback hooks from plugin manifests are
rejected at registration time because loading arbitrary dotted paths from
untrusted sources is a code-execution vector. Managed (policy) settings
can register callbacks if the operator trusts them.

Contract: the callable takes (hook_input: dict, ctx: CallbackContext) and
returns a dict matching SyncHookJSONOutput, or None for no-op. Any
exception is captured as a non_blocking_error.
"""
from __future__ import annotations

import asyncio
import importlib
import inspect
import logging
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .schemas import CallbackHook, HookResult, SyncHookJSONOutput

logger = logging.getLogger(__name__)


@dataclass
class CallbackContext:
    project_dir: str
    plugin_id: Optional[str] = None
    plugin_root: Optional[str] = None


def _resolve_callable(dotted: str) -> Callable:
    if ":" in dotted:
        module_name, attr = dotted.split(":", 1)
    else:
        module_name, _, attr = dotted.rpartition(".")
    if not module_name or not attr:
        raise ValueError(f"Invalid callback reference: {dotted!r}")
    module = importlib.import_module(module_name)
    fn = getattr(module, attr)
    if not callable(fn):
        raise TypeError(f"Callback target {dotted!r} is not callable")
    return fn


async def run_callback_hook(
    hook: CallbackHook,
    hook_input: dict[str, Any],
    ctx: CallbackContext,
    matcher: Optional[str] = None,
) -> HookResult:
    started = time.monotonic()
    try:
        fn = _resolve_callable(hook.callback)
    except Exception as exc:
        return HookResult(
            outcome="non_blocking_error",
            hook_type="callback",
            plugin_id=ctx.plugin_id,
            matcher=matcher,
            duration_ms=0,
            reason=f"failed to resolve callback: {exc}",
        )

    try:
        result: Any = fn(hook_input, ctx)
        if inspect.isawaitable(result):
            result = await result
    except Exception as exc:
        return HookResult(
            outcome="non_blocking_error",
            hook_type="callback",
            plugin_id=ctx.plugin_id,
            matcher=matcher,
            duration_ms=int((time.monotonic() - started) * 1000),
            reason=f"callback raised: {exc}",
        )

    duration_ms = int((time.monotonic() - started) * 1000)
    if result is None:
        return HookResult(
            outcome="ok",
            hook_type="callback",
            plugin_id=ctx.plugin_id,
            matcher=matcher,
            duration_ms=duration_ms,
        )
    if not isinstance(result, dict):
        return HookResult(
            outcome="non_blocking_error",
            hook_type="callback",
            plugin_id=ctx.plugin_id,
            matcher=matcher,
            duration_ms=duration_ms,
            reason=f"callback returned non-dict: {type(result).__name__}",
        )
    try:
        output = SyncHookJSONOutput.model_validate(result)
    except Exception as exc:
        return HookResult(
            outcome="non_blocking_error",
            hook_type="callback",
            plugin_id=ctx.plugin_id,
            matcher=matcher,
            duration_ms=duration_ms,
            reason=f"callback output failed schema: {exc}",
        )

    if output.decision == "block":
        return HookResult(
            outcome="blocking",
            hook_type="callback",
            plugin_id=ctx.plugin_id,
            matcher=matcher,
            duration_ms=duration_ms,
            reason=output.reason or "callback blocked",
            output=output,
        )
    return HookResult(
        outcome="ok",
        hook_type="callback",
        plugin_id=ctx.plugin_id,
        matcher=matcher,
        duration_ms=duration_ms,
        output=output,
    )


__all__ = ["CallbackContext", "run_callback_hook"]
