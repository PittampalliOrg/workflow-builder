from __future__ import annotations

import importlib
import json
import os
import sys

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

adapter = importlib.import_module("src.nvidia_adapter")


class _Response:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode()


def test_nvidia_auth_headers_require_api_key(monkeypatch) -> None:
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)

    try:
        adapter._auth_headers()
    except RuntimeError as exc:
        assert str(exc) == "No NVIDIA authentication configured. Set NVIDIA_API_KEY."
    else:
        raise AssertionError("Expected missing NVIDIA_API_KEY to raise RuntimeError")


def test_nvidia_chat_uses_openai_compatible_endpoint_and_key(monkeypatch) -> None:
    bodies: list[dict] = []
    auth_headers: list[str] = []
    urls: list[str] = []

    monkeypatch.setenv("NVIDIA_API_KEY", "nv-test")

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

    result = adapter._call_nvidia_chat(
        "llm-nvidia-llama31-8b",
        [{"role": "user", "content": "hello"}],
    )

    assert urls == ["https://integrate.api.nvidia.com/v1/chat/completions"]
    assert auth_headers == ["Bearer nv-test"]
    assert bodies[0]["model"] == "meta/llama-3.1-8b-instruct"
    assert bodies[0]["messages"] == [{"role": "user", "content": "hello"}]
    assert bodies[0]["stream"] is False
    assert result["content"] == "ok"
    assert result["metadata"]["provider"] == "nvidia-chat"


def test_nvidia_component_model_map_includes_coding_models() -> None:
    assert adapter.COMPONENT_MODEL_MAP["llm-nvidia-mistral-medium-35-128b"] == (
        "mistralai/mistral-medium-3.5-128b"
    )
    assert adapter.COMPONENT_MODEL_MAP["llm-nvidia-qwen3-coder-480b"] == (
        "qwen/qwen3-coder-480b-a35b-instruct"
    )
    assert adapter.COMPONENT_MODEL_MAP["llm-nvidia-devstral-2-123b"] == (
        "mistralai/devstral-2-123b-instruct-2512"
    )
    assert adapter.COMPONENT_MODEL_MAP["llm-nvidia-kimi-k2-thinking"] == (
        "moonshotai/kimi-k2-thinking"
    )
    assert adapter.COMPONENT_MODEL_MAP["llm-nvidia-kimi-k2-0905"] == (
        "moonshotai/kimi-k2-instruct-0905"
    )
    assert adapter.COMPONENT_MODEL_MAP["llm-nvidia-glm47"] == "z-ai/glm4.7"


def test_nvidia_tool_schema_uses_chat_completions_shape() -> None:
    class ArgsModel:
        @staticmethod
        def model_json_schema() -> dict:
            return {
                "type": "object",
                "properties": {"path": {"type": "string"}},
            }

    class Tool:
        name = "read_file"
        description = "Read a file"
        args_model = ArgsModel()

    out = adapter._convert_tools_for_nvidia_chat([Tool()])

    assert out == [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                },
            },
        }
    ]


def test_nvidia_tool_call_response_is_normalized() -> None:
    content, tool_calls, finish_reason = adapter._extract_nvidia_response({
        "choices": [{
            "finish_reason": "tool_calls",
            "message": {
                "content": None,
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


def test_nvidia_normalizer_preserves_tool_result_messages() -> None:
    messages = adapter._normalize_messages_for_nvidia(
        None,
        [
            {"role": "system", "content": "System"},
            {"role": "user", "content": "Read file"},
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": "file contents",
            },
        ],
    )

    assert messages == [
        {"role": "system", "content": "System"},
        {"role": "user", "content": "Read file"},
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "content": "file contents",
        },
    ]
