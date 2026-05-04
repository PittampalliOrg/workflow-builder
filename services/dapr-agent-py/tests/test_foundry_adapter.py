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

adapter = importlib.import_module("src.foundry_adapter")


class _Response:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode()


def test_foundry_auth_headers_require_api_key(monkeypatch) -> None:
    monkeypatch.delenv("AZURE_AI_FOUNDRY_API_KEY", raising=False)

    try:
        adapter._auth_headers()
    except RuntimeError as exc:
        assert "AZURE_AI_FOUNDRY_API_KEY" in str(exc)
    else:
        raise AssertionError("Expected missing AZURE_AI_FOUNDRY_API_KEY to raise")


def test_foundry_chat_uses_openai_v1_endpoint_and_key(monkeypatch) -> None:
    bodies: list[dict] = []
    headers: list[dict] = []
    urls: list[str] = []

    monkeypatch.setenv("AZURE_AI_FOUNDRY_API_KEY", "foundry-test")
    monkeypatch.setenv(
        "AZURE_AI_FOUNDRY_BASE_URL",
        "https://example.services.ai.azure.com/openai/v1",
    )

    def urlopen(req, timeout: int):
        urls.append(req.full_url)
        headers.append(dict(req.headers))
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

    result = adapter._call_foundry_chat(
        "llm-foundry-deepseek-v4-flash",
        [{"role": "user", "content": "hello"}],
    )

    assert urls == ["https://example.services.ai.azure.com/openai/v1/chat/completions"]
    assert headers[0]["Api-key"] == "foundry-test"
    assert headers[0]["Authorization"] == "Bearer foundry-test"
    assert bodies[0]["model"] == "DeepSeek-V4-Flash"
    assert bodies[0]["messages"] == [{"role": "user", "content": "hello"}]
    assert bodies[0]["stream"] is False
    assert result["content"] == "ok"
    assert result["metadata"]["provider"] == "azure-ai-foundry-chat"


def test_foundry_chat_sends_strict_response_format(monkeypatch) -> None:
    bodies: list[dict] = []

    class ConversationSummary(BaseModel):
        summary: str
        items: list[dict]

    monkeypatch.setenv("AZURE_AI_FOUNDRY_API_KEY", "foundry-test")

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

    adapter._call_foundry_chat(
        "llm-foundry-deepseek-v4-flash",
        [{"role": "user", "content": "summarize"}],
        response_format=ConversationSummary,
    )

    fmt = bodies[0]["response_format"]
    assert fmt["type"] == "json_schema"
    assert fmt["json_schema"]["name"] == "ConversationSummary"
    assert fmt["json_schema"]["strict"] is True
    assert fmt["json_schema"]["schema"]["additionalProperties"] is False
    assert fmt["json_schema"]["schema"]["required"] == ["summary", "items"]


def test_foundry_chat_retries_429_with_retry_after(monkeypatch) -> None:
    calls = 0
    sleeps: list[float] = []

    monkeypatch.setenv("AZURE_AI_FOUNDRY_API_KEY", "foundry-test")
    monkeypatch.setenv("AZURE_AI_FOUNDRY_RATE_LIMIT_MAX_RETRIES", "1")
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
                BytesIO(b'{"error":{"code":"RateLimitReached"}}'),
            )
        return _Response({
            "id": "chatcmpl_test",
            "choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_foundry_chat(
        "llm-foundry-deepseek-v4-flash",
        [{"role": "user", "content": "hello"}],
    )

    assert calls == 2
    assert sleeps == [0.25]
    assert result["content"] == "ok"


def test_foundry_tool_call_response_is_normalized() -> None:
    content, tool_calls, finish_reason, reasoning = adapter._extract_foundry_response({
        "choices": [{
            "finish_reason": "tool_calls",
            "message": {
                "content": "",
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


def test_foundry_structured_call_rejects_empty_content(monkeypatch) -> None:
    class ConversationSummary(BaseModel):
        summary: str

    monkeypatch.setenv("AZURE_AI_FOUNDRY_API_KEY", "foundry-test")

    def urlopen(req, timeout: int):
        return _Response({
            "id": "chatcmpl_test",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "A JSON object would be {\"summary\":\"ok\"}",
                },
                "finish_reason": "length",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    try:
        adapter._call_foundry_chat(
            "llm-foundry-kimi-k26",
            [{"role": "user", "content": "summarize"}],
            response_format=ConversationSummary,
        )
    except RuntimeError as exc:
        assert "empty assistant content" in str(exc)
    else:
        raise AssertionError("Expected empty structured Foundry content to fail")
