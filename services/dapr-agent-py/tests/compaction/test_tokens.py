"""Token counting + threshold math."""
from __future__ import annotations

from src.compaction.tokens import (
    AUTOCOMPACT_BUFFER_TOKENS,
    DEFAULT_WINDOW,
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    get_auto_compact_threshold,
    get_context_window,
    get_effective_window,
    heuristic_token_count,
)


def test_context_window_known_model():
    assert get_context_window("claude-sonnet-4-6") == 200_000
    assert get_context_window("claude-opus-4-7") == 1_000_000
    assert get_context_window("llm-nvidia-llama31-8b") == 128_000
    assert get_context_window("llm-nvidia-mistral-medium-35-128b") == 262_144
    assert get_context_window("llm-nvidia-qwen3-coder-480b") == 262_144
    assert get_context_window("llm-nvidia-devstral-2-123b") == 262_144
    assert get_context_window("llm-nvidia-kimi-k2-thinking") == 256_000
    assert get_context_window("llm-nvidia-kimi-k2-0905") == 256_000
    assert get_context_window("llm-nvidia-glm47") == 131_072
    assert get_context_window("llm-together-glm-51") == 128_000
    assert get_context_window("llm-together-qwen3-coder-480b") == 262_144
    assert get_context_window("llm-together-deepseek-v4-pro") == 512_000
    assert get_context_window("llm-deepseek-v4-pro") == 1_000_000
    assert get_context_window("deepseek-v4-flash") == 1_000_000
    assert get_context_window("llm-alibaba-qwen3-coder-plus") == 1_000_000
    assert get_context_window("llm-kimi-k26") == 256_000
    assert get_context_window("kimi-k2.5") == 256_000


def test_context_window_unknown_model_falls_back_to_default():
    assert get_context_window("totally-made-up") == DEFAULT_WINDOW
    assert get_context_window(None) == DEFAULT_WINDOW


def test_context_window_substring_match():
    # Date-suffix variants should still resolve to 200K.
    assert get_context_window("claude-sonnet-4-6-20250414") == 200_000


def test_effective_window_subtracts_reserve():
    assert (
        get_effective_window("claude-sonnet-4-6")
        == 200_000 - MAX_OUTPUT_TOKENS_FOR_SUMMARY
    )


def test_effective_window_respects_override():
    assert get_effective_window("claude-sonnet-4-6", window_override=50_000) == 50_000 - MAX_OUTPUT_TOKENS_FOR_SUMMARY


def test_auto_compact_threshold_applies_buffer():
    effective = get_effective_window("claude-sonnet-4-6")
    assert (
        get_auto_compact_threshold("claude-sonnet-4-6")
        == effective - AUTOCOMPACT_BUFFER_TOKENS
    )


def test_heuristic_token_count_scales_with_content():
    msgs = [
        {"role": "user", "content": "a" * 400},
        {"role": "assistant", "content": "b" * 400},
    ]
    count = heuristic_token_count(msgs)
    # 800 chars / 4 = 200, plus 2 * 8 overhead = 216
    assert count == 800 // 4 + 8 * 2


def test_heuristic_token_count_handles_list_content():
    msgs = [
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "hello " * 10},
                {"type": "tool_use", "name": "Bash", "input": {"cmd": "ls"}},
            ],
        }
    ]
    count = heuristic_token_count(msgs)
    assert count > 8  # non-trivial, greater than just the per-message overhead
