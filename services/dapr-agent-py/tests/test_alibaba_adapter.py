from __future__ import annotations

import importlib
import json
import os
import sys

from pydantic import BaseModel

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

adapter = importlib.import_module("src.alibaba_adapter")


class _Response:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode()


def test_alibaba_auth_headers_require_api_key(monkeypatch) -> None:
    monkeypatch.delenv("ALIBABA_API_KEY", raising=False)
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)

    try:
        adapter._auth_headers()
    except RuntimeError as exc:
        assert str(exc) == "No Alibaba authentication configured. Set ALIBABA_API_KEY."
    else:
        raise AssertionError("Expected missing ALIBABA_API_KEY to raise RuntimeError")


def test_alibaba_chat_uses_singapore_openai_compatible_endpoint(monkeypatch) -> None:
    bodies: list[dict] = []
    auth_headers: list[str] = []
    urls: list[str] = []
    timeouts: list[int] = []

    monkeypatch.setenv("ALIBABA_API_KEY", "alibaba-test")

    def urlopen(req, timeout: int):
        urls.append(req.full_url)
        auth_headers.append(req.headers["Authorization"])
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

    result = adapter._call_alibaba_chat(
        "llm-alibaba-qwen3-coder-plus",
        [{"role": "user", "content": "hello"}],
    )

    assert urls == [
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
    ]
    assert timeouts == [300]
    assert auth_headers == ["Bearer alibaba-test"]
    assert bodies[0]["model"] == "qwen3-coder-plus"
    assert bodies[0]["messages"] == [{"role": "user", "content": "hello"}]
    assert bodies[0]["max_tokens"] == 8192
    assert bodies[0]["stream"] is False
    assert result["content"] == "ok"
    assert result["metadata"]["provider"] == "alibaba-chat"


def test_alibaba_chat_accepts_dashscope_fallback_key(monkeypatch) -> None:
    auth_headers: list[str] = []

    monkeypatch.delenv("ALIBABA_API_KEY", raising=False)
    monkeypatch.setenv("DASHSCOPE_API_KEY", "dashscope-test")

    def urlopen(req, timeout: int):
        auth_headers.append(req.headers["Authorization"])
        return _Response({
            "id": "chatcmpl_test",
            "choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_alibaba_chat(
        "llm-alibaba-qwen3-coder-plus",
        [{"role": "user", "content": "hello"}],
    )

    assert auth_headers == ["Bearer dashscope-test"]
    assert result["metadata"]["auth_mode"] == "dashscope-api-key"


def test_alibaba_chat_converts_tools_and_tool_choice(monkeypatch) -> None:
    bodies: list[dict] = []
    tool_choice = {"type": "function", "function": {"name": "read_file"}}

    monkeypatch.setenv("ALIBABA_API_KEY", "alibaba-test")

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

    adapter._call_alibaba_chat(
        "llm-alibaba-qwen3-coder-plus",
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

    assert bodies[0]["tools"][0]["function"]["name"] == "read_file"
    assert bodies[0]["tool_choice"] == tool_choice


def test_alibaba_structured_output_prompts_for_json_without_response_format_by_default(
    monkeypatch,
) -> None:
    bodies: list[dict] = []

    class ConversationSummary(BaseModel):
        summary: str
        items: list[dict]

    monkeypatch.setenv("ALIBABA_API_KEY", "alibaba-test")

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

    result = adapter._call_alibaba_chat(
        "llm-alibaba-qwen3-coder-plus",
        [{"role": "user", "content": "summarize"}],
        response_format=ConversationSummary,
    )

    assert bodies[0]["messages"][0] == {
        "role": "system",
        "content": "Return a valid JSON object only.",
    }
    assert "response_format" not in bodies[0]
    parsed = adapter.parse_structured_response(ConversationSummary, result["content"])
    assert parsed.summary == "ok"


def test_alibaba_structured_output_can_enable_response_format(monkeypatch) -> None:
    bodies: list[dict] = []

    class ConversationSummary(BaseModel):
        summary: str

    monkeypatch.setenv("ALIBABA_API_KEY", "alibaba-test")
    monkeypatch.setenv("ALIBABA_USE_RESPONSE_FORMAT", "true")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response({
            "id": "chatcmpl_test",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "{\"summary\":\"ok\"}",
                },
                "finish_reason": "stop",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_alibaba_chat(
        "llm-alibaba-qwen3-coder-plus",
        [{"role": "user", "content": "summarize"}],
        response_format=ConversationSummary,
    )

    assert bodies[0]["response_format"] == {"type": "json_object"}
