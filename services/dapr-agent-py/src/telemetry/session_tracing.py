"""Span lifecycle for the `claude_code.*` span tree.

Python port of `claude-code-src/main/utils/telemetry/sessionTracing.ts`.

Span hierarchy (each level is a child of the one above):
  claude_code.interaction          — one per durable-agent turn
    claude_code.llm_request        — one per provider API call
    claude_code.tool               — one per tool dispatch
      claude_code.tool.blocked_on_user   — waiting for PreToolUse gating
      claude_code.tool.execution          — actual tool invocation
    claude_code.hook               — hook execution (beta only, like TS)

Parent/child is tracked with `contextvars.ContextVar` (Python's analog of
the TS `AsyncLocalStorage`). We rely on OpenTelemetry's own context
propagation for the span tree — the contextvars only store a
`_SpanHandle` so `end_*_span` can recover the span/startTime.
"""

from __future__ import annotations

import contextvars
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from . import beta
from .attributes import get_telemetry_attributes
from .providers import get_tracer

logger = logging.getLogger(__name__)


@dataclass
class _SpanHandle:
    span: Any
    start_time_ns: int
    start_monotonic: float
    attributes: dict[str, Any] = field(default_factory=dict)
    token: contextvars.Token | None = None  # reset token for ctx var
    ended: bool = False


_interaction_ctx: contextvars.ContextVar[_SpanHandle | None] = contextvars.ContextVar(
    "claude_code_interaction_handle", default=None
)
_tool_ctx: contextvars.ContextVar[_SpanHandle | None] = contextvars.ContextVar(
    "claude_code_tool_handle", default=None
)

# Explicit span ID → handle map for spans not held in contextvars
# (llm_request, tool.blocked_on_user, tool.execution, hook). Same rationale
# as the TS `strongSpans` map — keeps the handle alive while the call is
# in flight even across async boundaries.
_explicit_spans: dict[int, _SpanHandle] = {}

_interaction_sequence = 0


def _is_enabled() -> bool:
    return get_tracer() is not None


def _duration_ms(handle: _SpanHandle) -> int:
    return int((time.monotonic() - handle.start_monotonic) * 1000)


def _span_id(span: Any) -> int:
    try:
        return span.get_span_context().span_id
    except Exception:  # noqa: BLE001
        return id(span)


def _extract_ids_from_span(span: Any) -> tuple[str | None, str | None]:
    """Return (trace_id_hex, span_id_hex) for a span object, or (None, None)
    if the span is missing/invalid/non-recording."""
    try:
        if span is None:
            return None, None
        ctx = span.get_span_context()
        trace_id = getattr(ctx, "trace_id", 0) or 0
        span_id = getattr(ctx, "span_id", 0) or 0
        if not trace_id or not span_id:
            return None, None
        return f"{trace_id:032x}", f"{span_id:016x}"
    except Exception:  # noqa: BLE001
        return None, None


def get_current_trace_context() -> tuple[str | None, str | None]:
    """Return (trace_id_hex, span_id_hex) for the current agent-side context.

    Our span helpers (start_llm_request_span / start_tool_span / start_hook_span)
    use `tracer.start_span` without making the span current, and store handles
    either in `_tool_ctx` / `_interaction_ctx` ContextVars or in the explicit
    `_explicit_spans` map (keyed by span_id). So `get_current_span()` from
    OTEL returns the non-recording default in almost all call sites. We
    resolve in priority order:
      1. Innermost tool handle (_tool_ctx)
      2. Interaction handle (_interaction_ctx)
      3. The most-recently-started unended span in _explicit_spans
         (covers claude_code.llm_request / hook / tool.execution)
      4. OTEL current span fallback (works if caller wraps in `use_span`)
    """
    handle = _tool_ctx.get()
    if handle is not None:
        tid, sid = _extract_ids_from_span(handle.span)
        if tid:
            return tid, sid
    handle = _interaction_ctx.get()
    if handle is not None:
        tid, sid = _extract_ids_from_span(handle.span)
        if tid:
            return tid, sid
    # Pick the innermost (latest-started) not-yet-ended explicit span.
    if _explicit_spans:
        latest = max(
            (h for h in _explicit_spans.values() if not h.ended),
            key=lambda h: h.start_monotonic,
            default=None,
        )
        if latest is not None:
            tid, sid = _extract_ids_from_span(latest.span)
            if tid:
                return tid, sid
    try:
        from opentelemetry import trace as otel_trace

        return _extract_ids_from_span(otel_trace.get_current_span())
    except Exception:  # noqa: BLE001
        return None, None


def _build_attrs(span_type: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    attrs: dict[str, Any] = dict(get_telemetry_attributes())
    attrs["span.type"] = span_type
    if extra:
        for k, v in extra.items():
            if v is None:
                continue
            attrs[k] = v
    return attrs


# ---------------------------------------------------------------------------
# interaction
# ---------------------------------------------------------------------------

def start_interaction_span(user_prompt: str) -> Any:
    """Start `claude_code.interaction`, the root user-turn span.

    Redacts `user_prompt` unless `OTEL_LOG_USER_PROMPTS=1` (matches TS).
    """
    global _interaction_sequence
    tracer = get_tracer()
    if tracer is None:
        return None

    from .events import is_user_prompt_logging_enabled

    prompt_to_log = user_prompt if is_user_prompt_logging_enabled() else "<REDACTED>"
    _interaction_sequence += 1
    attrs = _build_attrs(
        "interaction",
        {
            "user_prompt": prompt_to_log,
            "user_prompt_length": len(user_prompt),
            "interaction.sequence": _interaction_sequence,
        },
    )

    span = tracer.start_span("claude_code.interaction", attributes=attrs)
    beta.add_interaction_attributes(span, user_prompt)

    # Promote curated attributes to MLflow trace tags so search filters
    # like `tag.session.id = '...'` work. Phase 1 of plan
    # research-the-most-popular-stateful-hinton.md. Best-effort: silent
    # no-op when mlflow isn't initialised.
    from .dapr_attributes import set_mlflow_trace_tags, trace_tags_from_attrs
    set_mlflow_trace_tags(trace_tags_from_attrs(attrs))

    handle = _SpanHandle(
        span=span,
        start_time_ns=time.time_ns(),
        start_monotonic=time.monotonic(),
        attributes=attrs,
    )
    handle.token = _interaction_ctx.set(handle)
    return span


def end_interaction_span() -> None:
    handle = _interaction_ctx.get()
    if handle is None or handle.ended:
        return
    try:
        handle.span.set_attribute("interaction.duration_ms", _duration_ms(handle))
        handle.span.end()
    except Exception as exc:  # noqa: BLE001
        logger.warning("end_interaction_span: %s", exc)
    handle.ended = True
    if handle.token is not None:
        try:
            _interaction_ctx.reset(handle.token)
        except ValueError:
            # Token belongs to another context (workflow replay across task boundaries).
            _interaction_ctx.set(None)


# ---------------------------------------------------------------------------
# llm_request
# ---------------------------------------------------------------------------

def start_llm_request_span(
    model: str,
    *,
    fast_mode: bool = False,
    query_source: str | None = None,
    system_prompt: str | None = None,
    tools_json: str | None = None,
    messages_for_api: list[dict[str, Any]] | None = None,
) -> Any:
    """Start `claude_code.llm_request` under the current interaction span (if any)."""
    tracer = get_tracer()
    if tracer is None:
        return None

    from opentelemetry import context as otel_context
    from opentelemetry import trace as otel_trace

    interaction_handle = _interaction_ctx.get()
    attrs = _build_attrs(
        "llm_request",
        {
            "model": model,
            "llm_request.context": "interaction" if interaction_handle else "standalone",
            "speed": "fast" if fast_mode else "normal",
        },
    )
    if query_source:
        attrs["query_source"] = query_source

    parent_ctx = (
        otel_trace.set_span_in_context(interaction_handle.span)
        if interaction_handle is not None
        else otel_context.get_current()
    )
    span = tracer.start_span(
        "claude_code.llm_request", attributes=attrs, context=parent_ctx
    )

    beta.add_llm_request_attributes(
        span,
        system_prompt=system_prompt,
        query_source=query_source,
        tools_json=tools_json,
        messages_for_api=messages_for_api,
    )

    handle = _SpanHandle(
        span=span,
        start_time_ns=time.time_ns(),
        start_monotonic=time.monotonic(),
        attributes=attrs,
    )
    _explicit_spans[_span_id(span)] = handle
    return span


def end_llm_request_span(
    span: Any,
    *,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cache_read_tokens: int | None = None,
    cache_creation_tokens: int | None = None,
    success: bool | None = None,
    status_code: int | None = None,
    error: str | None = None,
    attempt: int | None = None,
    has_tool_call: bool | None = None,
    ttft_ms: float | None = None,
    model_output: str | None = None,
    thinking_output: str | None = None,
) -> None:
    """End a span returned by `start_llm_request_span`. Span is required."""
    if span is None:
        return
    handle = _explicit_spans.pop(_span_id(span), None)
    if handle is None or handle.ended:
        return

    end_attrs: dict[str, Any] = {"duration_ms": _duration_ms(handle)}
    if input_tokens is not None:
        end_attrs["input_tokens"] = input_tokens
    if output_tokens is not None:
        end_attrs["output_tokens"] = output_tokens
    if cache_read_tokens is not None:
        end_attrs["cache_read_tokens"] = cache_read_tokens
    if cache_creation_tokens is not None:
        end_attrs["cache_creation_tokens"] = cache_creation_tokens
    if success is not None:
        end_attrs["success"] = success
    if status_code is not None:
        end_attrs["status_code"] = status_code
    if error is not None:
        end_attrs["error"] = error
    if attempt is not None:
        end_attrs["attempt"] = attempt
    if has_tool_call is not None:
        end_attrs["response.has_tool_call"] = has_tool_call
    if ttft_ms is not None:
        end_attrs["ttft_ms"] = ttft_ms

    beta.add_llm_response_attributes(
        end_attrs,
        model_output=model_output,
        thinking_output=thinking_output,
    )

    try:
        for k, v in end_attrs.items():
            span.set_attribute(k, v)
        span.end()
    except Exception as exc:  # noqa: BLE001
        logger.warning("end_llm_request_span: %s", exc)
    handle.ended = True


# ---------------------------------------------------------------------------
# tool + tool.execution + tool.blocked_on_user
# ---------------------------------------------------------------------------

def start_tool_span(
    tool_name: str,
    *,
    tool_attributes: dict[str, Any] | None = None,
    tool_input: str | None = None,
) -> Any:
    tracer = get_tracer()
    if tracer is None:
        return None

    from opentelemetry import context as otel_context
    from opentelemetry import trace as otel_trace

    interaction_handle = _interaction_ctx.get()
    attrs = _build_attrs(
        "tool",
        {"tool_name": tool_name, **(tool_attributes or {})},
    )
    parent_ctx = (
        otel_trace.set_span_in_context(interaction_handle.span)
        if interaction_handle is not None
        else otel_context.get_current()
    )
    span = tracer.start_span(
        "claude_code.tool", attributes=attrs, context=parent_ctx
    )
    if tool_input:
        beta.add_tool_input_attributes(span, tool_name, tool_input)

    handle = _SpanHandle(
        span=span,
        start_time_ns=time.time_ns(),
        start_monotonic=time.monotonic(),
        attributes=attrs,
    )
    handle.token = _tool_ctx.set(handle)
    return span


def end_tool_span(
    *,
    tool_result: str | None = None,
    result_tokens: int | None = None,
) -> None:
    handle = _tool_ctx.get()
    if handle is None or handle.ended:
        return
    end_attrs: dict[str, Any] = {"duration_ms": _duration_ms(handle)}
    if tool_result is not None:
        beta.add_tool_result_attributes(
            end_attrs, str(handle.attributes.get("tool_name") or "unknown"), tool_result
        )
    if result_tokens is not None:
        end_attrs["result_tokens"] = result_tokens
    try:
        for k, v in end_attrs.items():
            handle.span.set_attribute(k, v)
        handle.span.end()
    except Exception as exc:  # noqa: BLE001
        logger.warning("end_tool_span: %s", exc)
    handle.ended = True
    if handle.token is not None:
        try:
            _tool_ctx.reset(handle.token)
        except ValueError:
            _tool_ctx.set(None)


def start_tool_blocked_on_user_span() -> Any:
    tracer = get_tracer()
    if tracer is None:
        return None

    from opentelemetry import context as otel_context
    from opentelemetry import trace as otel_trace

    tool_handle = _tool_ctx.get()
    attrs = _build_attrs("tool.blocked_on_user")
    parent_ctx = (
        otel_trace.set_span_in_context(tool_handle.span)
        if tool_handle is not None
        else otel_context.get_current()
    )
    span = tracer.start_span(
        "claude_code.tool.blocked_on_user", attributes=attrs, context=parent_ctx
    )
    handle = _SpanHandle(
        span=span,
        start_time_ns=time.time_ns(),
        start_monotonic=time.monotonic(),
        attributes=attrs,
    )
    _explicit_spans[_span_id(span)] = handle
    return span


def end_tool_blocked_on_user_span(
    span: Any,
    *,
    decision: str | None = None,
    source: str | None = None,
) -> None:
    if span is None:
        return
    handle = _explicit_spans.pop(_span_id(span), None)
    if handle is None or handle.ended:
        return
    end_attrs: dict[str, Any] = {"duration_ms": _duration_ms(handle)}
    if decision is not None:
        end_attrs["decision"] = decision
    if source is not None:
        end_attrs["source"] = source
    try:
        for k, v in end_attrs.items():
            span.set_attribute(k, v)
        span.end()
    except Exception as exc:  # noqa: BLE001
        logger.warning("end_tool_blocked_on_user_span: %s", exc)
    handle.ended = True


def start_tool_execution_span() -> Any:
    tracer = get_tracer()
    if tracer is None:
        return None

    from opentelemetry import context as otel_context
    from opentelemetry import trace as otel_trace

    tool_handle = _tool_ctx.get()
    attrs = _build_attrs("tool.execution")
    parent_ctx = (
        otel_trace.set_span_in_context(tool_handle.span)
        if tool_handle is not None
        else otel_context.get_current()
    )
    span = tracer.start_span(
        "claude_code.tool.execution", attributes=attrs, context=parent_ctx
    )
    handle = _SpanHandle(
        span=span,
        start_time_ns=time.time_ns(),
        start_monotonic=time.monotonic(),
        attributes=attrs,
    )
    _explicit_spans[_span_id(span)] = handle
    return span


def end_tool_execution_span(
    span: Any,
    *,
    success: bool | None = None,
    error: str | None = None,
    tool_output: str | None = None,
) -> None:
    if span is None:
        return
    handle = _explicit_spans.pop(_span_id(span), None)
    if handle is None or handle.ended:
        return
    end_attrs: dict[str, Any] = {"duration_ms": _duration_ms(handle)}
    if success is not None:
        end_attrs["success"] = success
    if error is not None:
        end_attrs["error"] = error
    if tool_output is not None:
        # Truncate to keep span attribute size bounded — same convention as
        # system_prompt_preview (500 chars). Larger payloads can still be
        # reconstructed from the underlying tool result; this is the at-a-
        # glance preview surfaced in MLflow Traces / Phoenix.
        end_attrs["tool_output_preview"] = tool_output[:8000]
        end_attrs["tool_output_length"] = len(tool_output)
    try:
        for k, v in end_attrs.items():
            span.set_attribute(k, v)
        span.end()
    except Exception as exc:  # noqa: BLE001
        logger.warning("end_tool_execution_span: %s", exc)
    handle.ended = True


# ---------------------------------------------------------------------------
# hook (beta only, like TS)
# ---------------------------------------------------------------------------

def start_hook_span(
    hook_event: str,
    hook_name: str,
    num_hooks: int,
    hook_definitions: str,
) -> Any:
    if not beta.is_beta_tracing_enabled():
        return None
    tracer = get_tracer()
    if tracer is None:
        return None

    from opentelemetry import context as otel_context
    from opentelemetry import trace as otel_trace

    parent_handle = _tool_ctx.get() or _interaction_ctx.get()
    attrs = _build_attrs(
        "hook",
        {
            "hook_event": hook_event,
            "hook_name": hook_name,
            "num_hooks": num_hooks,
            "hook_definitions": hook_definitions,
        },
    )
    parent_ctx = (
        otel_trace.set_span_in_context(parent_handle.span)
        if parent_handle is not None
        else otel_context.get_current()
    )
    span = tracer.start_span(
        "claude_code.hook", attributes=attrs, context=parent_ctx
    )
    handle = _SpanHandle(
        span=span,
        start_time_ns=time.time_ns(),
        start_monotonic=time.monotonic(),
        attributes=attrs,
    )
    _explicit_spans[_span_id(span)] = handle
    return span


def end_hook_span(
    span: Any,
    *,
    num_success: int | None = None,
    num_blocking: int | None = None,
    num_non_blocking_error: int | None = None,
    num_cancelled: int | None = None,
) -> None:
    if span is None or not beta.is_beta_tracing_enabled():
        return
    handle = _explicit_spans.pop(_span_id(span), None)
    if handle is None or handle.ended:
        return
    end_attrs: dict[str, Any] = {"duration_ms": _duration_ms(handle)}
    if num_success is not None:
        end_attrs["num_success"] = num_success
    if num_blocking is not None:
        end_attrs["num_blocking"] = num_blocking
    if num_non_blocking_error is not None:
        end_attrs["num_non_blocking_error"] = num_non_blocking_error
    if num_cancelled is not None:
        end_attrs["num_cancelled"] = num_cancelled
    try:
        for k, v in end_attrs.items():
            span.set_attribute(k, v)
        span.end()
    except Exception as exc:  # noqa: BLE001
        logger.warning("end_hook_span: %s", exc)
    handle.ended = True
