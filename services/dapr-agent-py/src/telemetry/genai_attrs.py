"""GenAI semantic-convention helpers for OTel spans.

Each adapter calls these to enrich the currently-active span (which is the
Dapr workflow activity span the dapr-agents WorkflowActivityRegistrationWrapper
creates around `call_llm`). Without these, the LLM span has only the bare
`agent.name`, `gen_ai.operation.name=chat`, and `input.value` / `output.value`
JSON blobs — token usage is buried inside the JSON instead of exposed as
searchable OTel attributes.

Attributes follow the OTel GenAI semantic conventions:
  https://opentelemetry.io/docs/specs/semconv/gen-ai/

All helpers are best-effort: missing OTel install or no active span → no-op.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping
import logging

logger = logging.getLogger(__name__)


def get_current_span() -> Any | None:
    """Return the currently-active OTel span, or None if unavailable."""
    try:
        from opentelemetry import trace as ot_trace

        span = ot_trace.get_current_span()
        if span is None:
            return None
        ctx = getattr(span, "get_span_context", None)
        if callable(ctx):
            sc = ctx()
            if sc and getattr(sc, "trace_id", 0) == 0:
                return None
        return span
    except Exception:
        return None


def _safe_set(span: Any, key: str, value: Any) -> None:
    """Set a span attribute, swallowing any backend exceptions."""
    if span is None or value is None:
        return
    try:
        if isinstance(value, str) and not value:
            return
        if isinstance(value, (list, tuple)) and not value:
            return
        span.set_attribute(key, value)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[genai-attrs] set_attribute(%s) failed: %s", key, exc)


def set_genai_request_attrs(
    span: Any | None = None,
    *,
    system: str | None = None,
    request_model: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    top_p: float | None = None,
    top_k: int | None = None,
    presence_penalty: float | None = None,
    frequency_penalty: float | None = None,
    stop_sequences: Iterable[str] | None = None,
    seed: int | None = None,
    tools_count: int | None = None,
    tool_choice: str | None = None,
    response_format: str | None = None,
    streaming: bool | None = None,
    extra: Mapping[str, Any] | None = None,
) -> None:
    """Stamp GenAI request-side semconv attrs on the active span."""
    if span is None:
        span = get_current_span()
    if span is None:
        return
    if system:
        _safe_set(span, "gen_ai.system", system)
        # Phoenix / OpenInference compat
        _safe_set(span, "gen_ai.provider.name", system)
        _safe_set(span, "llm.provider", system)
    if request_model:
        _safe_set(span, "gen_ai.request.model", request_model)
        _safe_set(span, "llm.model_name", request_model)
    if max_tokens is not None:
        _safe_set(span, "gen_ai.request.max_tokens", int(max_tokens))
    if temperature is not None:
        _safe_set(span, "gen_ai.request.temperature", float(temperature))
    if top_p is not None:
        _safe_set(span, "gen_ai.request.top_p", float(top_p))
    if top_k is not None:
        _safe_set(span, "gen_ai.request.top_k", int(top_k))
    if presence_penalty is not None:
        _safe_set(span, "gen_ai.request.presence_penalty", float(presence_penalty))
    if frequency_penalty is not None:
        _safe_set(span, "gen_ai.request.frequency_penalty", float(frequency_penalty))
    if stop_sequences:
        try:
            _safe_set(span, "gen_ai.request.stop_sequences", list(stop_sequences))
        except Exception:
            pass
    if seed is not None:
        _safe_set(span, "gen_ai.request.seed", int(seed))
    if tools_count is not None:
        _safe_set(span, "gen_ai.request.tools.count", int(tools_count))
    if tool_choice:
        _safe_set(span, "gen_ai.request.tool_choice", str(tool_choice))
    if response_format:
        _safe_set(span, "gen_ai.request.response_format", str(response_format))
    if streaming is not None:
        _safe_set(span, "gen_ai.request.streaming", bool(streaming))
    if extra:
        for k, v in extra.items():
            _safe_set(span, str(k), v)


def normalize_usage(usage: Any) -> dict[str, int]:
    """Convert Anthropic/OpenAI/dict usage shapes into a canonical dict.

    Returns keys ready for `gen_ai.usage.*` mapping:
      input_tokens, output_tokens, total_tokens,
      cache_read_input_tokens, cache_creation_input_tokens,
      reasoning_tokens (if surfaced by provider).
    """
    if usage is None:
        return {}
    if not isinstance(usage, dict):
        # SDK object → dict-ish via attribute access
        usage = {
            k: getattr(usage, k, None)
            for k in (
                "input_tokens",
                "output_tokens",
                "prompt_tokens",
                "completion_tokens",
                "total_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
                "prompt_tokens_details",
                "completion_tokens_details",
                "reasoning_tokens",
            )
        }

    def _int_or_none(v: Any) -> int | None:
        if v is None:
            return None
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    in_t = _int_or_none(usage.get("input_tokens")) or _int_or_none(
        usage.get("prompt_tokens")
    )
    out_t = _int_or_none(usage.get("output_tokens")) or _int_or_none(
        usage.get("completion_tokens")
    )
    total_t = _int_or_none(usage.get("total_tokens"))
    if total_t is None and in_t is not None and out_t is not None:
        total_t = in_t + out_t

    cache_r = _int_or_none(usage.get("cache_read_input_tokens"))
    cache_c = _int_or_none(usage.get("cache_creation_input_tokens"))
    # Kimi/DeepSeek-style flat cache fields (Kimi: cached_tokens)
    if cache_r is None:
        cache_r = _int_or_none(usage.get("cached_tokens")) or _int_or_none(
            usage.get("prompt_cache_hit_tokens")
        )
    # OpenAI-style nested cache fields
    if cache_r is None:
        ptd = usage.get("prompt_tokens_details") or {}
        if isinstance(ptd, dict):
            cache_r = _int_or_none(ptd.get("cached_tokens"))

    reasoning_t = _int_or_none(usage.get("reasoning_tokens"))
    if reasoning_t is None:
        ctd = usage.get("completion_tokens_details") or {}
        if isinstance(ctd, dict):
            reasoning_t = _int_or_none(ctd.get("reasoning_tokens"))

    out: dict[str, int] = {}
    if in_t is not None:
        out["input_tokens"] = in_t
    if out_t is not None:
        out["output_tokens"] = out_t
    if total_t is not None:
        out["total_tokens"] = total_t
    if cache_r is not None:
        out["cache_read_input_tokens"] = cache_r
    if cache_c is not None:
        out["cache_creation_input_tokens"] = cache_c
    if reasoning_t is not None:
        out["reasoning_tokens"] = reasoning_t
    return out


def set_genai_response_attrs(
    span: Any | None = None,
    *,
    response_model: str | None = None,
    response_id: str | None = None,
    finish_reason: str | None = None,
    usage: Any = None,
    duration_ms: float | None = None,
    ttft_ms: float | None = None,
    tool_calls_count: int | None = None,
    output_chars: int | None = None,
    cost_usd: float | None = None,
) -> None:
    """Stamp GenAI response-side semconv attrs on the active span."""
    if span is None:
        span = get_current_span()
    if span is None:
        return
    if response_model:
        _safe_set(span, "gen_ai.response.model", response_model)
    if response_id:
        _safe_set(span, "gen_ai.response.id", response_id)
    if finish_reason:
        _safe_set(span, "gen_ai.response.finish_reasons", [str(finish_reason)])
    if duration_ms is not None:
        _safe_set(span, "gen_ai.response.duration_ms", float(duration_ms))
    if ttft_ms is not None:
        _safe_set(span, "gen_ai.response.ttft_ms", float(ttft_ms))
    if tool_calls_count is not None:
        _safe_set(span, "gen_ai.response.tool_calls.count", int(tool_calls_count))
    if output_chars is not None:
        _safe_set(span, "gen_ai.response.content.chars", int(output_chars))
    if cost_usd is not None:
        _safe_set(span, "gen_ai.response.cost.usd", float(cost_usd))

    norm = normalize_usage(usage)
    if "input_tokens" in norm:
        _safe_set(span, "gen_ai.usage.input_tokens", norm["input_tokens"])
        # OpenInference / Phoenix UI compat keys
        _safe_set(span, "llm.token_count.prompt", norm["input_tokens"])
    if "output_tokens" in norm:
        _safe_set(span, "gen_ai.usage.output_tokens", norm["output_tokens"])
        _safe_set(span, "llm.token_count.completion", norm["output_tokens"])
    if "total_tokens" in norm:
        _safe_set(span, "gen_ai.usage.total_tokens", norm["total_tokens"])
        _safe_set(span, "llm.token_count.total", norm["total_tokens"])
    if "cache_read_input_tokens" in norm:
        _safe_set(
            span,
            "gen_ai.usage.cache_read_input_tokens",
            norm["cache_read_input_tokens"],
        )
        _safe_set(span, "llm.token_count.cache_read", norm["cache_read_input_tokens"])
    if "cache_creation_input_tokens" in norm:
        _safe_set(
            span,
            "gen_ai.usage.cache_creation_input_tokens",
            norm["cache_creation_input_tokens"],
        )
        _safe_set(
            span,
            "llm.token_count.cache_creation",
            norm["cache_creation_input_tokens"],
        )
    if "reasoning_tokens" in norm:
        _safe_set(span, "gen_ai.usage.reasoning_tokens", norm["reasoning_tokens"])
        _safe_set(span, "llm.token_count.reasoning", norm["reasoning_tokens"])

    if response_model and norm:
        try:
            from src.compaction.tokens import context_usage_fields

            fields = context_usage_fields(
                model=response_model,
                input_tokens=norm.get("input_tokens"),
                cache_read_input_tokens=norm.get("cache_read_input_tokens"),
                cache_creation_input_tokens=norm.get("cache_creation_input_tokens"),
            )
            attr_map = {
                "context_window_size": "llm.context_window.size",
                "context_input_tokens": "llm.context.input_tokens",
                "context_used_percentage": "llm.context.used_percentage",
                "context_remaining_percentage": "llm.context.remaining_percentage",
                "context_effective_window": "llm.context.effective_window",
                "context_auto_compact_threshold": "llm.context.auto_compact_threshold",
                "context_until_auto_compact_percentage": "llm.context.until_auto_compact_percentage",
            }
            for field, attr in attr_map.items():
                _safe_set(span, attr, fields.get(field))
        except Exception as exc:  # noqa: BLE001
            logger.debug("[genai-attrs] context usage attrs failed: %s", exc)


def set_activity_attrs(
    span: Any | None = None,
    *,
    workflow_id: str | None = None,
    workflow_execution_id: str | None = None,
    workflow_instance_id: str | None = None,
    workflow_activity_correlation_id: str | None = None,
    workflow_node_id: str | None = None,
    workflow_node_name: str | None = None,
    session_id: str | None = None,
    agent_id: str | None = None,
    agent_version: int | str | None = None,
    agent_slug: str | None = None,
    agent_app_id: str | None = None,
    component: str | None = None,
    iteration: int | None = None,
    span_type: str | None = None,
    extra: Mapping[str, Any] | None = None,
) -> None:
    """Generic workflow-context attrs for any Dapr activity span."""
    if span is None:
        span = get_current_span()
    if span is None:
        return
    if workflow_id:
        _safe_set(span, "workflow.id", workflow_id)
    if workflow_execution_id:
        _safe_set(span, "workflow.execution.id", workflow_execution_id)
    if workflow_instance_id:
        _safe_set(span, "workflow.instance_id", workflow_instance_id)
    if workflow_activity_correlation_id:
        _safe_set(
            span,
            "workflow.activity.correlation_id",
            workflow_activity_correlation_id,
        )
    if workflow_node_id:
        _safe_set(span, "workflow.node.id", workflow_node_id)
    if workflow_node_name:
        _safe_set(span, "workflow.node.name", workflow_node_name)
    if session_id:
        _safe_set(span, "session.id", session_id)
    if agent_id:
        _safe_set(span, "agent.id", agent_id)
    if agent_version is not None:
        _safe_set(span, "agent.version", agent_version)
    if agent_slug:
        _safe_set(span, "agent.slug", agent_slug)
    if agent_app_id:
        _safe_set(span, "agent.app_id", agent_app_id)
    if component:
        _safe_set(span, "dapr.component", component)
    if iteration is not None:
        _safe_set(span, "agent.iteration", int(iteration))
    if span_type:
        _safe_set(span, "span.type", span_type)
        _safe_set(
            span,
            "openinference.span.kind",
            {
                "llm_request": "LLM",
                "tool": "TOOL",
                "agent": "AGENT",
            }.get(span_type, "CHAIN"),
        )
    if extra:
        for k, v in extra.items():
            _safe_set(span, str(k), v)


__all__ = [
    "get_current_span",
    "normalize_usage",
    "set_activity_attrs",
    "set_genai_request_attrs",
    "set_genai_response_attrs",
]
