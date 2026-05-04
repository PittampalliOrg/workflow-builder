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

adapter = importlib.import_module("src.together_adapter")


class _Response:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode()


def test_together_auth_headers_require_api_key(monkeypatch) -> None:
    monkeypatch.delenv("TOGETHER_API_KEY", raising=False)

    try:
        adapter._auth_headers()
    except RuntimeError as exc:
        assert str(exc) == "No Together AI authentication configured. Set TOGETHER_API_KEY."
    else:
        raise AssertionError("Expected missing TOGETHER_API_KEY to raise RuntimeError")


def test_together_chat_uses_openai_compatible_endpoint_and_key(monkeypatch) -> None:
    bodies: list[dict] = []
    auth_headers: list[str] = []
    urls: list[str] = []

    monkeypatch.setenv("TOGETHER_API_KEY", "together-test")

    def urlopen(req, timeout: int):
        urls.append(req.full_url)
        auth_headers.append(req.headers["Authorization"])
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

    result = adapter._call_together_chat(
        "llm-together-glm-51",
        [{"role": "user", "content": "hello"}],
    )

    assert urls == ["https://api.together.ai/v1/chat/completions"]
    assert auth_headers == ["Bearer together-test"]
    assert bodies[0]["model"] == "zai-org/GLM-5.1"
    assert bodies[0]["messages"] == [{"role": "user", "content": "hello"}]
    assert bodies[0]["stream"] is False
    assert result["content"] == "ok"
    assert result["metadata"]["provider"] == "together-chat"


def test_together_chat_sends_strict_response_format(monkeypatch) -> None:
    bodies: list[dict] = []

    class ConversationSummary(BaseModel):
        summary: str
        items: list[dict]

    monkeypatch.setenv("TOGETHER_API_KEY", "together-test")

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

    result = adapter._call_together_chat(
        "llm-together-glm-51",
        [{"role": "user", "content": "summarize"}],
        response_format=ConversationSummary,
    )

    fmt = bodies[0]["response_format"]
    assert fmt["type"] == "json_schema"
    assert fmt["json_schema"]["name"] == "ConversationSummary"
    assert fmt["json_schema"]["strict"] is True
    assert fmt["json_schema"]["schema"]["additionalProperties"] is False
    assert fmt["json_schema"]["schema"]["required"] == ["summary", "items"]
    parsed = adapter.parse_structured_response(ConversationSummary, result["content"])
    assert parsed.summary == "ok"


def test_together_chat_retries_429_with_retry_after(monkeypatch) -> None:
    calls = 0
    sleeps: list[float] = []

    monkeypatch.setenv("TOGETHER_API_KEY", "together-test")
    monkeypatch.setenv("TOGETHER_RATE_LIMIT_MAX_RETRIES", "1")
    monkeypatch.setattr(adapter.time, "sleep", lambda value: sleeps.append(value))

    def urlopen(req, timeout: int):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise HTTPError(
                req.full_url,
                429,
                "rate limited",
                {"Retry-After": "0.25"},
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

    result = adapter._call_together_chat(
        "llm-together-glm-51",
        [{"role": "user", "content": "hello"}],
    )

    assert calls == 2
    assert sleeps == [0.25]
    assert result["content"] == "ok"


def test_together_chat_retries_429_with_fallback_backoff(monkeypatch) -> None:
    calls = 0
    sleeps: list[float] = []

    monkeypatch.setenv("TOGETHER_API_KEY", "together-test")
    monkeypatch.setenv("TOGETHER_RATE_LIMIT_MAX_RETRIES", "1")
    monkeypatch.setenv("TOGETHER_RATE_LIMIT_BACKOFF_SECONDS", "0.5")
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

    result = adapter._call_together_chat(
        "llm-together-glm-51",
        [{"role": "user", "content": "hello"}],
    )

    assert calls == 2
    assert sleeps == [0.5]
    assert result["content"] == "ok"


def test_together_tool_call_response_is_normalized() -> None:
    content, tool_calls, finish_reason, reasoning = adapter._extract_together_response({
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


def test_together_normalizer_collapses_invalid_tool_history() -> None:
    messages = adapter._normalize_messages_for_together(
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
