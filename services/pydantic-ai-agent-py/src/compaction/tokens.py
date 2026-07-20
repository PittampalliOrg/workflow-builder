"""Context-window occupancy fields (Kimi K3 focused).

Minimal port of dapr-agent-py's ``src/compaction/tokens.py`` — same field
names and math, trimmed to this runtime's single provider. The vendored
``event_publisher`` lazily imports ``context_usage_fields`` to stamp
``context_*`` window-occupancy telemetry onto ``agent.llm_usage`` events;
Session Pulse's Context % tile reads them (`context_source=provider_usage`).
"""

from __future__ import annotations

import os

# Claude Code parity constants (autoCompact.ts)
MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
AUTOCOMPACT_BUFFER_TOKENS = 13_000

KIMI_K3_DEFAULT_CONTEXT_WINDOW = 1_048_576
KIMI_K3_CONTEXT_KEYS = {"kimi-k3", "llm-kimi-k3", "kimi/kimi-k3"}
DEFAULT_WINDOW = KIMI_K3_DEFAULT_CONTEXT_WINDOW


def _kimi_k3_context_window() -> int:
    try:
        value = int(os.environ.get("KIMI_CONTEXT_WINDOW", ""))
    except (TypeError, ValueError):
        return KIMI_K3_DEFAULT_CONTEXT_WINDOW
    return value if value > 0 else KIMI_K3_DEFAULT_CONTEXT_WINDOW


def get_context_window(model: str | None) -> int:
    if model:
        normalized = model.strip().lower()
        if normalized in KIMI_K3_CONTEXT_KEYS or "kimi" in normalized:
            return _kimi_k3_context_window()
    return DEFAULT_WINDOW


def get_effective_window(
    model: str | None,
    *,
    window_override: int | None = None,
    summary_reserve: int = MAX_OUTPUT_TOKENS_FOR_SUMMARY,
) -> int:
    base = get_context_window(model)
    if window_override and window_override > 0:
        base = min(base, window_override)
    return max(0, base - summary_reserve)


def get_auto_compact_threshold(
    model: str | None,
    *,
    window_override: int | None = None,
    summary_reserve: int = MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    buffer_tokens: int = AUTOCOMPACT_BUFFER_TOKENS,
) -> int:
    effective = get_effective_window(
        model, window_override=window_override, summary_reserve=summary_reserve
    )
    return max(0, effective - buffer_tokens)


def _clamp_percentage(value: float) -> int:
    try:
        return max(0, min(100, int(round(value))))
    except Exception:  # noqa: BLE001
        return 0


def context_usage_fields(
    *,
    model: str | None,
    input_tokens: int | float | None = None,
    cache_read_input_tokens: int | float | None = None,
    cache_creation_input_tokens: int | float | None = None,
    token_count: int | float | None = None,
    window_override: int | None = None,
    summary_reserve: int = MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    buffer_tokens: int = AUTOCOMPACT_BUFFER_TOKENS,
) -> dict[str, int]:
    """Additive context-window telemetry fields (same contract as dapr-agent-py).

    ``input_tokens`` mirrors the (net-of-cache) provider usage event; context
    occupancy is net input + cache reads + cache creation.
    """

    def _int(value: int | float | None) -> int:
        try:
            return max(0, int(value or 0))
        except (TypeError, ValueError):
            return 0

    prompt = _int(input_tokens)
    cache_read = _int(cache_read_input_tokens)
    cache_create = _int(cache_creation_input_tokens)
    context_input = _int(token_count)
    if context_input <= 0:
        context_input = prompt + cache_read + cache_create

    window = get_context_window(model)
    used_percentage = (
        _clamp_percentage((context_input / window) * 100) if window > 0 else 0
    )
    remaining_percentage = max(0, 100 - used_percentage)
    effective = get_effective_window(
        model, window_override=window_override, summary_reserve=summary_reserve
    )
    threshold = get_auto_compact_threshold(
        model,
        window_override=window_override,
        summary_reserve=summary_reserve,
        buffer_tokens=buffer_tokens,
    )
    if threshold > 0:
        until_auto = _clamp_percentage(((threshold - context_input) / threshold) * 100)
    else:
        until_auto = 0

    return {
        "context_window_size": window,
        "context_input_tokens": context_input,
        "context_used_percentage": used_percentage,
        "context_remaining_percentage": remaining_percentage,
        "context_effective_window": effective,
        "context_auto_compact_threshold": threshold,
        "context_until_auto_compact_percentage": until_auto,
    }
