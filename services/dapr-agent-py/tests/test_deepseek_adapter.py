from __future__ import annotations

import importlib
from io import BytesIO
import json
import os
import sys
from urllib.error import HTTPError

from pydantic import BaseModel

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

adapter = importlib.import_module("src.deepseek_adapter")


class _Response:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode()


def test_deepseek_auth_headers_require_api_key(monkeypatch) -> None:
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    try:
        adapter._auth_headers()
    except RuntimeError as exc:
        assert str(exc) == "No DeepSeek authentication configured. Set DEEPSEEK_API_KEY."
    else:
        raise AssertionError("Expected missing DEEPSEEK_API_KEY to raise RuntimeError")


def test_deepseek_chat_uses_openai_compatible_endpoint_key_and_thinking(monkeypatch) -> None:
    bodies: list[dict] = []
    auth_headers: list[str] = []
    user_agents: list[str | None] = []
    urls: list[str] = []
    timeouts: list[int] = []

    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-test")
    monkeypatch.setenv("DEEPSEEK_REASONING_EFFORT", "max")

    def urlopen(req, timeout: int):
        urls.append(req.full_url)
        auth_headers.append(req.headers["Authorization"])
        user_agents.append(req.get_header("User-agent"))
        bodies.append(json.loads(req.data.decode()))
        timeouts.append(timeout)
        return _Response({
            "id": "chatcmpl_test",
            "choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2},
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_deepseek_chat(
        "llm-deepseek-v4-pro",
        [{"role": "user", "content": "hello"}],
    )

    assert urls == ["https://api.deepseek.com/chat/completions"]
    assert timeouts == [300]
    assert auth_headers == ["Bearer deepseek-test"]
    assert user_agents == ["workflow-builder-dapr-agent-py/1.0"]
    assert bodies[0]["model"] == "deepseek-v4-pro"
    assert bodies[0]["messages"] == [{"role": "user", "content": "hello"}]
    assert bodies[0]["thinking"] == {"type": "enabled"}
    assert bodies[0]["reasoning_effort"] == "max"
    assert bodies[0]["stream"] is False
    assert result["content"] == "ok"
    assert result["metadata"]["provider"] == "deepseek-chat"


def test_deepseek_chat_selects_flash_model(monkeypatch) -> None:
    bodies: list[dict] = []

    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response({
            "id": "chatcmpl_test",
            "choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_deepseek_chat(
        "llm-deepseek-v4-flash",
        [{"role": "user", "content": "hello"}],
    )

    assert bodies[0]["model"] == "deepseek-v4-flash"


def test_deepseek_chat_accepts_dict_tool_choice(monkeypatch) -> None:
    bodies: list[dict] = []
    tool_choice = {"type": "function", "function": {"name": "read_file"}}

    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response({
            "id": "chatcmpl_test",
            "choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_deepseek_chat(
        "llm-deepseek-v4-pro",
        [{"role": "user", "content": "read"}],
        tools=[{
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file",
                "parameters": {"type": "object", "properties": {}},
            },
        }],
        tool_choice=tool_choice,
    )

    assert bodies[0]["tool_choice"] == tool_choice
    assert bodies[0]["thinking"] == {"type": "disabled"}
    assert "reasoning_effort" not in bodies[0]


def test_deepseek_chat_accepts_none_tool_choice(monkeypatch) -> None:
    bodies: list[dict] = []

    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response({
            "id": "chatcmpl_test",
            "choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_deepseek_chat(
        "llm-deepseek-v4-pro",
        [{"role": "user", "content": "read"}],
        tools=[{
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file",
                "parameters": {"type": "object", "properties": {}},
            },
        }],
        tool_choice="none",
    )

    assert bodies[0]["tools"][0]["function"]["name"] == "read_file"
    assert bodies[0]["tool_choice"] == "none"
    assert bodies[0]["thinking"] == {"type": "disabled"}
    assert "reasoning_effort" not in bodies[0]


def test_deepseek_structured_output_uses_json_object_and_disables_thinking(
    monkeypatch,
) -> None:
    bodies: list[dict] = []

    class ConversationSummary(BaseModel):
        summary: str
        items: list[dict]

    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response({
            "id": "chatcmpl_test",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "{\"summary\":\"ok\",\"items\":[]}",
                },
                "finish_reason": "stop",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_deepseek_chat(
        "llm-deepseek-v4-pro",
        [{"role": "user", "content": "summarize"}],
        response_format=ConversationSummary,
    )

    assert bodies[0]["messages"][0] == {
        "role": "system",
        "content": "Return a valid JSON object only.",
    }
    assert bodies[0]["messages"][1] == {"role": "user", "content": "summarize"}
    assert bodies[0]["response_format"] == {"type": "json_object"}
    assert "json_schema" not in bodies[0]["response_format"]
    assert bodies[0]["thinking"] == {"type": "disabled"}
    assert "reasoning_effort" not in bodies[0]
    parsed = adapter.parse_structured_response(ConversationSummary, result["content"])
    assert parsed.summary == "ok"


def test_deepseek_chat_retries_429_with_retry_after_ms(monkeypatch) -> None:
    calls = 0
    sleeps: list[float] = []

    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-test")
    monkeypatch.setenv("DEEPSEEK_RATE_LIMIT_MAX_RETRIES", "1")
    monkeypatch.setattr(adapter.time, "sleep", lambda value: sleeps.append(value))

    def urlopen(req, timeout: int):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise HTTPError(
                req.full_url,
                429,
                "rate limited",
                {"Retry-After-Ms": "250"},
                BytesIO(b'{"error":{"message":"rate limited"}}'),
            )
        return _Response({
            "id": "chatcmpl_test",
            "choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_deepseek_chat(
        "llm-deepseek-v4-pro",
        [{"role": "user", "content": "hello"}],
    )

    assert calls == 2
    assert sleeps == [0.25]
    assert result["content"] == "ok"


def test_deepseek_chat_retries_429_with_fallback_backoff(monkeypatch) -> None:
    calls = 0
    sleeps: list[float] = []

    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-test")
    monkeypatch.setenv("DEEPSEEK_RATE_LIMIT_MAX_RETRIES", "1")
    monkeypatch.setenv("DEEPSEEK_RATE_LIMIT_BACKOFF_SECONDS", "0.5")
    monkeypatch.setattr(adapter.time, "sleep", lambda value: sleeps.append(value))

    def urlopen(req, timeout: int):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise HTTPError(
                req.full_url,
                429,
                "rate limited",
                {},
                BytesIO(b'{"error":{"message":"rate limited"}}'),
            )
        return _Response({
            "id": "chatcmpl_test",
            "choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_deepseek_chat(
        "llm-deepseek-v4-pro",
        [{"role": "user", "content": "hello"}],
    )

    assert calls == 2
    assert sleeps == [0.5]
    assert result["content"] == "ok"


def test_deepseek_tool_call_response_is_normalized() -> None:
    content, tool_calls, finish_reason, reasoning = adapter._extract_deepseek_response({
        "choices": [{
            "finish_reason": "tool_calls",
            "message": {
                "content": None,
                "reasoning_content": "I should read the file.",
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "arguments": "{\"path\":\"README.md\"}",
                    },
                }],
            },
        }]
    })

    assert content == ""
    assert finish_reason == "tool_calls"
    assert reasoning == "I should read the file."
    assert tool_calls == [
        {
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "read_file",
                "arguments": "{\"path\":\"README.md\"}",
            },
        }
    ]


def test_deepseek_normalizer_collapses_invalid_tool_history() -> None:
    messages = adapter._normalize_messages_for_deepseek(
        None,
        [
            {"role": "system", "content": "System"},
            {"role": "user", "content": "Read file"},
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": "file contents",
            },
            {"role": "user", "content": "continue"},
        ],
    )

    assert messages[0] == {"role": "system", "content": "System"}
    assert messages[1]["role"] == "user"
    assert "tool-call ordering was invalid" in messages[1]["content"]
    assert "[tool] file contents" in messages[1]["content"]


def test_deepseek_reasoning_effort_override_wins_over_env(monkeypatch) -> None:
    """Per-agent agentConfig.reasoningEffort (threaded as reasoning_effort=) beats
    the env default; the Claude Code vocabulary collapses to the provider's set
    ({low,medium,high} -> high, {xhigh,max} -> max)."""
    bodies: list[dict] = []
    monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-test")
    monkeypatch.setenv("DEEPSEEK_REASONING_EFFORT", "max")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response({
            "id": "chatcmpl_test",
            "choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2},
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_deepseek_chat(
        "llm-deepseek-v4-pro",
        [{"role": "user", "content": "hello"}],
        reasoning_effort="low",
    )
    assert bodies[0]["reasoning_effort"] == "high"  # low -> high, env max ignored


def test_deepseek_reasoning_effort_mapping() -> None:
    assert adapter._reasoning_effort("low") == "high"
    assert adapter._reasoning_effort("medium") == "high"
    assert adapter._reasoning_effort("high") == "high"
    assert adapter._reasoning_effort("xhigh") == "max"
    assert adapter._reasoning_effort("max") == "max"
    # unknown override falls through to the terminal default
    assert adapter._reasoning_effort("bogus") == "max"
