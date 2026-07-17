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

adapter = importlib.import_module("src.kimi_adapter")


class _Response:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode()


def test_kimi_auth_headers_require_api_key(monkeypatch) -> None:
    monkeypatch.delenv("KIMI_API_KEY", raising=False)
    monkeypatch.setenv("MOONSHOT_API_KEY", "legacy-key-must-not-be-used")

    try:
        adapter._auth_headers()
    except RuntimeError as exc:
        assert str(exc) == "No Kimi authentication configured. Set KIMI_API_KEY."
    else:
        raise AssertionError("Expected missing KIMI_API_KEY to raise RuntimeError")


def test_kimi_auth_headers_use_kimi_api_key(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")

    headers, auth_mode = adapter._auth_headers()

    assert headers["Authorization"] == "Bearer kimi-test"
    assert auth_mode == "kimi-api-key"


def test_kimi_k3_chat_uses_openai_compatible_endpoint_and_max_reasoning(
    monkeypatch,
) -> None:
    bodies: list[dict] = []
    auth_headers: list[str] = []
    user_agents: list[str | None] = []
    urls: list[str] = []
    timeouts: list[int] = []

    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")

    def urlopen(req, timeout: int):
        urls.append(req.full_url)
        auth_headers.append(req.headers["Authorization"])
        user_agents.append(req.get_header("User-agent"))
        bodies.append(json.loads(req.data.decode()))
        timeouts.append(timeout)
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "reasoning_content": "reasoning",
                            "content": "ok",
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2},
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "hello"}],
    )

    assert urls == ["https://api.moonshot.ai/v1/chat/completions"]
    assert timeouts == [300]
    assert auth_headers == ["Bearer kimi-test"]
    assert user_agents == ["workflow-builder-dapr-agent-py/1.0"]
    assert bodies[0]["model"] == "kimi-k3"
    assert bodies[0]["messages"] == [{"role": "user", "content": "hello"}]
    assert bodies[0]["reasoning_effort"] == "max"
    assert "thinking" not in bodies[0]
    assert bodies[0]["max_completion_tokens"] == 131072
    assert "max_tokens" not in bodies[0]
    assert "prompt_cache_key" not in bodies[0]
    assert bodies[0]["stream"] is False
    assert result["content"] == "ok"
    assert result["reasoning_content"] == "reasoning"
    assert result["metadata"]["provider"] == "kimi-chat"


def test_kimi_component_map_only_contains_k3() -> None:
    assert adapter.COMPONENT_MODEL_MAP == {"llm-kimi-k3": "kimi-k3"}


def test_kimi_chat_accepts_dict_tool_choice(monkeypatch) -> None:
    bodies: list[dict] = []
    tool_choice = {"type": "function", "function": {"name": "read_file"}}

    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "read"}],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a file",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
        tool_choice=tool_choice,
    )

    assert bodies[0]["tool_choice"] == tool_choice
    assert bodies[0]["tools"][0]["function"]["strict"] is False
    assert bodies[0]["reasoning_effort"] == "max"
    assert "thinking" not in bodies[0]


def test_kimi_chat_accepts_none_tool_choice(monkeypatch) -> None:
    bodies: list[dict] = []

    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "read"}],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a file",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
        tool_choice="none",
    )

    assert bodies[0]["tools"][0]["function"]["name"] == "read_file"
    assert bodies[0]["tool_choice"] == "none"
    assert bodies[0]["reasoning_effort"] == "max"
    assert "thinking" not in bodies[0]


def test_kimi_structured_output_uses_strict_json_schema_and_max_reasoning(
    monkeypatch,
) -> None:
    bodies: list[dict] = []

    class ConversationSummary(BaseModel):
        summary: str
        items: list[dict]

    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": '{"summary":"ok","items":[]}',
                        },
                        "finish_reason": "stop",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "summarize"}],
        response_format=ConversationSummary,
    )

    assert bodies[0]["messages"][0] == {
        "role": "system",
        "content": "Return a valid JSON object only.",
    }
    assert bodies[0]["messages"][1] == {"role": "user", "content": "summarize"}
    assert bodies[0]["response_format"]["type"] == "json_schema"
    assert bodies[0]["response_format"]["json_schema"]["name"] == "ConversationSummary"
    assert bodies[0]["response_format"]["json_schema"]["strict"] is True
    schema = bodies[0]["response_format"]["json_schema"]["schema"]
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == {"summary", "items"}
    assert bodies[0]["reasoning_effort"] == "max"
    assert "thinking" not in bodies[0]
    parsed = adapter.parse_structured_response(ConversationSummary, result["content"])
    assert parsed.summary == "ok"


def test_kimi_dynamic_script_schema_uses_native_strict_json_schema(monkeypatch) -> None:
    bodies: list[dict] = []
    schema = {
        "type": "object",
        "properties": {"ok": {"type": "boolean"}},
    }
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": '{"ok":true}'},
                        "finish_reason": "stop",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "return status"}],
        native_json_schema=schema,
    )

    response_format = bodies[0]["response_format"]
    assert response_format["type"] == "json_schema"
    assert response_format["json_schema"]["name"] == "structured_output"
    assert response_format["json_schema"]["strict"] is True
    assert response_format["json_schema"]["schema"] == {
        "type": "object",
        "properties": {"ok": {"type": "boolean"}},
        "required": ["ok"],
        "additionalProperties": False,
    }
    assert bodies[0]["reasoning_effort"] == "max"
    assert "thinking" not in bodies[0]


def test_kimi_chat_retries_429_with_retry_after_ms(monkeypatch) -> None:
    calls = 0
    sleeps: list[float] = []

    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    monkeypatch.setenv("KIMI_RATE_LIMIT_MAX_RETRIES", "1")
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
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "hello"}],
    )

    assert calls == 2
    assert sleeps == [0.25]
    assert result["content"] == "ok"


def test_kimi_chat_retries_429_with_fallback_backoff(monkeypatch) -> None:
    calls = 0
    sleeps: list[float] = []

    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    monkeypatch.setenv("KIMI_RATE_LIMIT_MAX_RETRIES", "1")
    monkeypatch.setenv("KIMI_RATE_LIMIT_BACKOFF_SECONDS", "0.5")
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
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "hello"}],
    )

    assert calls == 2
    assert sleeps == [0.5]
    assert result["content"] == "ok"


def test_kimi_tool_call_response_is_normalized() -> None:
    content, tool_calls, finish_reason, reasoning = adapter._extract_kimi_response(
        {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": None,
                        "reasoning_content": "I should read the file.",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "read_file",
                                    "arguments": '{"path":"README.md"}',
                                },
                            }
                        ],
                    },
                }
            ]
        }
    )

    assert content == ""
    assert finish_reason == "tool_calls"
    assert reasoning == "I should read the file."
    assert tool_calls == [
        {
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "read_file",
                "arguments": '{"path":"README.md"}',
            },
        }
    ]


def test_kimi_k3_reasoning_and_tool_calls_survive_durable_history_replay() -> None:
    tool_calls = [
        {
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "read_file",
                "arguments": '{"path":"README.md"}',
            },
        }
    ]
    response = adapter._build_kimi_chat_response(
        content="",
        reasoning_content="I should read the file.",
        tool_calls=tool_calls,
        metadata={"model": "kimi-k3"},
    )

    stored = response.get_message().model_dump()
    assert stored["content"] == ""
    assert stored["reasoning_content"] == "I should read the file."
    assert stored["tool_calls"] == tool_calls

    replay = adapter._normalize_messages_for_kimi(
        None,
        [
            {"role": "user", "content": "Read the file."},
            stored,
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": "file contents",
            },
        ],
    )
    assert replay[1] == {
        "role": "assistant",
        "content": None,
        "reasoning_content": "I should read the file.",
        "tool_calls": tool_calls,
    }


def test_kimi_reasoning_state_schema_round_trips_reasoning_content() -> None:
    from dapr_agents.agents.configs import DEFAULT_AGENT_WORKFLOW_BUNDLE

    adapter.install_kimi_reasoning_state_schema()
    message = adapter.coerce_kimi_reasoning_message(
        {
            "role": "assistant",
            "content": "",
            "reasoning_content": "durable reasoning",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": "{}"},
                }
            ],
        }
    )
    entry = DEFAULT_AGENT_WORKFLOW_BUNDLE.entry_model_cls(
        messages=[message],
        last_message=message,
    )

    restored = DEFAULT_AGENT_WORKFLOW_BUNDLE.entry_model_cls.model_validate(
        entry.model_dump()
    )
    assert restored.messages[0].reasoning_content == "durable reasoning"
    assert restored.last_message.reasoning_content == "durable reasoning"


def test_kimi_normalizer_collapses_invalid_tool_history() -> None:
    messages = adapter._normalize_messages_for_kimi(
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
