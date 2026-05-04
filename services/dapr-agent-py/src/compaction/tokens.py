"""Token counting + context window math.

Ports the threshold logic from
claude-code-src/main/services/compact/autoCompact.ts.

Primary counter: Anthropic's `client.messages.count_tokens()` when the
current LLM component is Anthropic (authoritative).
Fallback: chars/4 heuristic matching `roughTokenCountEstimation`.

No caching in state — token counts derive from `entry.messages`, so they
are cheap to recompute and automatically replay-safe.
"""
from __future__ import annotations

import logging
from typing import Any, Iterable

logger = logging.getLogger(__name__)

# Claude Code parity constants (autoCompact.ts:30-65)
MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
AUTOCOMPACT_BUFFER_TOKENS = 13_000

# Model -> context window (tokens). Keep in sync with
# anthropic_adapter.COMPONENT_MODEL_MAP.
CONTEXT_WINDOWS: dict[str, int] = {
    "claude-sonnet-4-6": 200_000,
    "claude-sonnet-4-6-20250414": 200_000,
    "claude-opus-4-6": 1_000_000,
    "claude-opus-4-7": 1_000_000,
    "claude-haiku-4-5": 200_000,
    "claude-haiku-4-5-20251001": 200_000,
    "gemini-2.5-pro": 1_000_000,
    "gpt-4o": 128_000,
    "gpt-4.1": 1_000_000,
    "gpt-5": 400_000,
    "meta/llama-3.1-8b-instruct": 128_000,
    "llm-nvidia-llama31-8b": 128_000,
    "mistralai/mistral-medium-3.5-128b": 262_144,
    "llm-nvidia-mistral-medium-35-128b": 262_144,
    "qwen/qwen3-coder-480b-a35b-instruct": 262_144,
    "llm-nvidia-qwen3-coder-480b": 262_144,
    "mistralai/devstral-2-123b-instruct-2512": 262_144,
    "llm-nvidia-devstral-2-123b": 262_144,
    "moonshotai/kimi-k2-thinking": 256_000,
    "llm-nvidia-kimi-k2-thinking": 256_000,
    "moonshotai/kimi-k2-instruct-0905": 256_000,
    "llm-nvidia-kimi-k2-0905": 256_000,
    "z-ai/glm4.7": 131_072,
    "llm-nvidia-glm47": 131_072,
}
DEFAULT_WINDOW = 200_000


def get_context_window(model: str | None) -> int:
    """Return the raw context-window size for a model id (tokens)."""
    if not model:
        return DEFAULT_WINDOW
    # exact match first, then substring (model ids sometimes include date suffix)
    if model in CONTEXT_WINDOWS:
        return CONTEXT_WINDOWS[model]
    for key, window in CONTEXT_WINDOWS.items():
        if key in model or model in key:
            return window
    return DEFAULT_WINDOW


def get_effective_window(
    model: str | None,
    *,
    window_override: int | None = None,
    summary_reserve: int = MAX_OUTPUT_TOKENS_FOR_SUMMARY,
) -> int:
    """Effective working window = min(window, override) - reserve."""
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
    """Token count at/above which auto-compaction should trigger."""
    effective = get_effective_window(
        model, window_override=window_override, summary_reserve=summary_reserve
    )
    return max(0, effective - buffer_tokens)


def _message_text(msg: Any) -> str:
    """Extract a flat text representation from a message (dict or Pydantic)."""
    if isinstance(msg, dict):
        content = msg.get("content") or ""
        tool_calls = msg.get("tool_calls") or []
    else:
        content = getattr(msg, "content", "") or ""
        tool_calls = getattr(msg, "tool_calls", None) or []

    parts: list[str] = []
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    parts.append(str(block.get("text") or ""))
                elif block.get("type") == "tool_use":
                    parts.append(str(block.get("name") or ""))
                    parts.append(str(block.get("input") or ""))
                elif block.get("type") == "tool_result":
                    inner = block.get("content")
                    if isinstance(inner, str):
                        parts.append(inner)
                    elif isinstance(inner, list):
                        for ib in inner:
                            if isinstance(ib, dict):
                                parts.append(str(ib.get("text") or ""))
    elif content:
        parts.append(str(content))

    for tc in tool_calls:
        if isinstance(tc, dict):
            fn = tc.get("function") or {}
            parts.append(str(fn.get("name") or ""))
            parts.append(str(fn.get("arguments") or ""))
    return "\n".join(p for p in parts if p)


def heuristic_token_count(messages: Iterable[Any]) -> int:
    """Chars-divided-by-4 fallback estimator (~Claude Code's rough counter)."""
    total_chars = 0
    msg_count = 0
    for msg in messages:
        total_chars += len(_message_text(msg))
        msg_count += 1
    # 8 tokens per message overhead for role/framing
    return total_chars // 4 + 8 * msg_count


def count_tokens(
    messages: Iterable[Any],
    *,
    model: str | None = None,
    anthropic_client: Any = None,
) -> int:
    """Count tokens in a message list. Uses Anthropic count_tokens when
    available, heuristic otherwise.

    `anthropic_client` is optional; when provided and the model is
    Anthropic, we call `client.messages.count_tokens()`. Any failure
    falls back silently to the heuristic so compaction never fails just
    because counting failed.
    """
    messages_list = list(messages)
    if anthropic_client is not None and model and "claude" in model:
        try:
            anthropic_msgs = _to_anthropic_counting_shape(messages_list)
            if anthropic_msgs:
                result = anthropic_client.messages.count_tokens(
                    model=model,
                    messages=anthropic_msgs,
                )
                return int(getattr(result, "input_tokens", 0) or 0)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[compaction] count_tokens API fell back: %s", exc)
    return heuristic_token_count(messages_list)


def _to_anthropic_counting_shape(messages: list[Any]) -> list[dict[str, Any]]:
    """Minimal conversion to the shape count_tokens accepts — role+content.

    count_tokens validates messages the same way create() does, so we
    need to drop system messages and preserve tool_use/tool_result
    alternation. For threshold-check purposes the heuristic is good
    enough, so if conversion looks risky we return [] and fall through.
    """
    out: list[dict[str, Any]] = []
    for msg in messages:
        role = getattr(msg, "role", None) if not isinstance(msg, dict) else msg.get("role")
        if role in (None, "system"):
            continue
        text = _message_text(msg)
        if not text:
            continue
        # Anthropic roles are only user/assistant; coerce tool messages to user.
        if role == "tool":
            role = "user"
        out.append({"role": role, "content": text})
    # Consecutive same-role must be merged for count_tokens to accept.
    merged: list[dict[str, Any]] = []
    for m in out:
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1]["content"] += "\n" + m["content"]
        else:
            merged.append(m)
    return merged


__all__ = [
    "MAX_OUTPUT_TOKENS_FOR_SUMMARY",
    "AUTOCOMPACT_BUFFER_TOKENS",
    "CONTEXT_WINDOWS",
    "DEFAULT_WINDOW",
    "get_context_window",
    "get_effective_window",
    "get_auto_compact_threshold",
    "heuristic_token_count",
    "count_tokens",
]
