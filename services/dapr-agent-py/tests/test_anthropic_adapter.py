from __future__ import annotations

import importlib
import os
import sys

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

adapter = importlib.import_module("src.anthropic_adapter")


def test_anthropic_normalizer_forwards_system_messages() -> None:
    system, messages = adapter._normalize_messages_for_anthropic(
        None,
        [
            {"role": "system", "content": "System one"},
            {"role": "assistant", "content": "Prior assistant"},
            {"role": "system", "content": [{"type": "text", "text": "System two"}]},
            {"role": "user", "content": "Current user"},
        ],
    )

    assert system == "System one\n\nSystem two"
    assert messages == [
        {"role": "assistant", "content": "Prior assistant"},
        {"role": "user", "content": "Current user"},
    ]


def test_anthropic_normalizer_preserves_tool_result_shape() -> None:
    system, messages = adapter._normalize_messages_for_anthropic(
        None,
        [
            {"role": "system", "content": "System"},
            {
                "role": "tool",
                "content": "Tool output",
                "tool_call_id": "toolu_smoke",
            },
        ],
    )

    assert system == "System"
    assert messages == [
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_smoke",
                    "content": "Tool output",
                }
            ],
        }
    ]


def test_anthropic_normalizer_sanitizes_foreign_tool_call_ids() -> None:
    _system, messages = adapter._normalize_messages_for_anthropic(
        None,
        [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "Grep:5",
                        "function": {"name": "Grep", "arguments": '{"pattern":"x"}'},
                    }
                ],
            },
            {
                "role": "tool",
                "content": "match",
                "tool_call_id": "Grep:5",
            },
        ],
    )

    assert messages[0]["content"][0]["id"] == "Grep_5"
    assert messages[1]["content"][0]["tool_use_id"] == "Grep_5"


def test_anthropic_sdk_requires_api_key(monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    try:
        adapter._call_anthropic_sdk(
            "llm-anthropic-sonnet",
            [{"role": "user", "content": "hello"}],
        )
    except RuntimeError as exc:
        assert str(exc) == "No Anthropic authentication configured. Set ANTHROPIC_API_KEY."
    else:
        raise AssertionError("Expected missing ANTHROPIC_API_KEY to raise RuntimeError")
