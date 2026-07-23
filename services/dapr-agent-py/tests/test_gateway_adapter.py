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

adapter = importlib.import_module("src.gateway_adapter")


class _Response:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode()


def test_mlflow_only_configuration_does_not_enable_gateway(monkeypatch) -> None:
    monkeypatch.delenv("LLM_GATEWAY_OPENAI_BASE_URL", raising=False)
    monkeypatch.setenv("MLFLOW_AI_GATEWAY_BASE_URL", "http://retired-gateway.test")
    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_ADAPTER_ENABLED", "true")
    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_ZAI", "true")

    assert adapter._gateway_base_url() == ""
    assert adapter._model_for_component("llm-glm-5.2") is None


def test_glm_52_model_requires_zai_feature_flag(monkeypatch) -> None:
    monkeypatch.setenv(
        "LLM_GATEWAY_OPENAI_BASE_URL",
        "http://preview-runtime-egress.workflow-builder.svc.cluster.local:7000/v1",
    )
    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_ADAPTER_ENABLED", "true")
    monkeypatch.delenv("DAPR_AGENT_PY_GATEWAY_ZAI", raising=False)

    assert adapter._model_for_component("llm-glm-5.2") is None

    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_ZAI", "true")
    assert adapter._provider_for_component("llm-glm-5.2") == "zai"
    assert adapter._model_for_component("llm-glm-5.2") == "glm-5.2"


def test_kimi_k3_model_requires_kimi_feature_flag(monkeypatch) -> None:
    monkeypatch.setenv(
        "LLM_GATEWAY_OPENAI_BASE_URL",
        "http://preview-runtime-egress.workflow-builder.svc.cluster.local:7000/v1",
    )
    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_ADAPTER_ENABLED", "true")
    monkeypatch.delenv("DAPR_AGENT_PY_GATEWAY_KIMI", raising=False)

    assert adapter._model_for_component("llm-kimi-k3") is None

    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_KIMI", "true")
    assert adapter._provider_for_component("llm-kimi-k3") == "kimi"
    assert adapter._model_for_component("llm-kimi-k3") == "kimi-k3"


def test_kimi_k3_gateway_uses_max_reasoning_and_completion_defaults(monkeypatch) -> None:
    requests = []
    monkeypatch.setenv("LLM_GATEWAY_OPENAI_BASE_URL", "http://gateway.test/v1")
    monkeypatch.setenv("KIMI_REASONING_EFFORT", "max")
    monkeypatch.delenv("KIMI_MAX_COMPLETION_TOKENS", raising=False)
    monkeypatch.delenv("KIMI_MAX_TOKENS", raising=False)

    def urlopen(req, timeout: int):
        requests.append(req)
        return _Response({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "done",
                    "reasoning_content": "I checked the result.",
                },
                "finish_reason": "stop",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_gateway_chat(
        "llm-kimi-k3",
        "kimi-k3",
        [{"role": "user", "content": "Finish the task."}],
    )

    body = json.loads(requests[0].data)
    assert body["model"] == "kimi-k3"
    assert body["reasoning_effort"] == "max"
    assert body["max_completion_tokens"] == 131_072
    assert "max_tokens" not in body
    assert "thinking" not in body
    assert result["reasoning_content"] == "I checked the result."


def test_kimi_k3_gateway_forwards_supported_per_agent_reasoning_effort(monkeypatch) -> None:
    requests = []
    monkeypatch.setenv("LLM_GATEWAY_OPENAI_BASE_URL", "http://gateway.test/v1")
    monkeypatch.setenv("KIMI_REASONING_EFFORT", "max")

    def urlopen(req, timeout: int):
        requests.append(req)
        return _Response({
            "choices": [{
                "message": {"role": "assistant", "content": "done"},
                "finish_reason": "stop",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    for effort in ("low", "high"):
        adapter._call_gateway_chat(
            "llm-kimi-k3",
            "kimi-k3",
            [{"role": "user", "content": "Finish the task."}],
            reasoning_effort=effort,
        )

    assert [json.loads(request.data)["reasoning_effort"] for request in requests] == [
        "low",
        "high",
    ]


def test_kimi_k3_gateway_replays_reasoning_with_tool_history(monkeypatch) -> None:
    requests = []
    monkeypatch.setenv("LLM_GATEWAY_OPENAI_BASE_URL", "http://gateway.test/v1")
    monkeypatch.setenv("KIMI_REASONING_EFFORT", "max")
    tool_calls = [{
        "id": "call_1",
        "type": "function",
        "function": {"name": "read_file", "arguments": '{"path":"README.md"}'},
    }]
    messages = adapter._normalize_gateway_messages(
        "kimi-k3",
        None,
        [
            {"role": "user", "content": "Read the file."},
            {
                "role": "assistant",
                "content": "",
                "reasoning_content": "I should inspect the file.",
                "tool_calls": tool_calls,
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "contents"},
        ],
    )

    def urlopen(req, timeout: int):
        requests.append(req)
        return _Response({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "I need another file.",
                    "tool_calls": tool_calls,
                },
                "finish_reason": "tool_calls",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)
    result = adapter._call_gateway_chat(
        "llm-kimi-k3",
        "kimi-k3",
        messages,
        tools=[{
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file",
                "parameters": {"type": "object", "properties": {}},
            },
        }],
    )

    body = json.loads(requests[0].data)
    assert body["messages"][1]["reasoning_content"] == "I should inspect the file."
    assert body["messages"][1]["tool_calls"] == tool_calls
    assert body["tools"][0]["function"]["strict"] is False
    assert result["reasoning_content"] == "I need another file."
    assert result["tool_calls"] == tool_calls
    stored = adapter._build_gateway_chat_response("kimi-k3", result).get_message().model_dump()
    assert stored["reasoning_content"] == "I need another file."
    assert stored["tool_calls"] == tool_calls


def test_kimi_k3_gateway_uses_strict_pydantic_json_schema(monkeypatch) -> None:
    class Summary(BaseModel):
        summary: str

    requests = []
    monkeypatch.setenv("LLM_GATEWAY_OPENAI_BASE_URL", "http://gateway.test/v1")
    monkeypatch.setenv("KIMI_REASONING_EFFORT", "max")

    def urlopen(req, timeout: int):
        requests.append(req)
        return _Response({
            "choices": [{
                "message": {"role": "assistant", "content": '{"summary":"ok"}'},
                "finish_reason": "stop",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)
    adapter._call_gateway_chat(
        "llm-kimi-k3",
        "kimi-k3",
        [{"role": "user", "content": "Return JSON."}],
        response_format=Summary,
    )

    response_format = json.loads(requests[0].data)["response_format"]
    assert response_format["type"] == "json_schema"
    assert response_format["json_schema"]["name"] == "Summary"
    assert response_format["json_schema"]["strict"] is True
    assert response_format["json_schema"]["schema"]["additionalProperties"] is False


def test_kimi_k3_gateway_uses_raw_native_json_schema(monkeypatch) -> None:
    requests = []
    schema = {
        "type": "object",
        "required": ["ok"],
        "properties": {"ok": {"type": "boolean"}},
    }
    monkeypatch.setenv("LLM_GATEWAY_OPENAI_BASE_URL", "http://gateway.test/v1")
    monkeypatch.setenv("KIMI_REASONING_EFFORT", "max")

    def urlopen(req, timeout: int):
        requests.append(req)
        return _Response({
            "choices": [{
                "message": {"role": "assistant", "content": '{"ok":true}'},
                "finish_reason": "stop",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)
    adapter._call_gateway_chat(
        "llm-kimi-k3",
        "kimi-k3",
        [{"role": "user", "content": "Decide."}],
        native_json_schema=schema,
    )

    body = json.loads(requests[0].data)
    assert "json" in body["messages"][0]["content"].lower()
    response_format = body["response_format"]
    assert response_format["type"] == "json_schema"
    assert response_format["json_schema"]["name"] == "structured_output"
    assert response_format["json_schema"]["strict"] is True
    assert response_format["json_schema"]["schema"]["required"] == ["ok"]


def test_kimi_k3_gateway_structured_output_tool_mode_composes_tools(
    monkeypatch,
) -> None:
    requests = []
    schema = {
        "type": "object",
        "required": ["ok"],
        "properties": {"ok": {"type": "boolean"}},
    }
    messages = [{"role": "user", "content": "Inspect, then decide."}]
    monkeypatch.setenv("LLM_GATEWAY_OPENAI_BASE_URL", "http://gateway.test/v1")
    monkeypatch.setenv("KIMI_REASONING_EFFORT", "max")

    def urlopen(req, timeout: int):
        requests.append(req)
        return _Response({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call_structured",
                        "type": "function",
                        "function": {
                            "name": "StructuredOutput",
                            "arguments": '{"ok":true}',
                        },
                    }],
                },
                "finish_reason": "tool_calls",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)
    result = adapter._call_gateway_chat(
        "llm-kimi-k3",
        "kimi-k3",
        messages,
        tools=[{
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file",
                "parameters": {"type": "object", "properties": {}},
            },
        }],
        native_json_schema=schema,
        structured_output_tool=True,
    )

    body = json.loads(requests[0].data)
    tools_by_name = {
        tool["function"]["name"]: tool["function"] for tool in body["tools"]
    }
    assert set(tools_by_name) == {"StructuredOutput", "read_file"}
    assert tools_by_name["StructuredOutput"]["parameters"] == schema
    assert tools_by_name["StructuredOutput"]["strict"] is False
    assert body["messages"] == messages
    assert body["tool_choice"] == "auto"
    assert body["reasoning_effort"] == "max"
    assert "response_format" not in body
    assert result["content"] == ""
    assert result["tool_calls"][0]["function"]["name"] == "StructuredOutput"


def test_gateway_patch_threads_kimi_schema_and_tool_modes(monkeypatch) -> None:
    from dapr_agents.llm.dapr import DaprChatClient

    schema = {
        "type": "object",
        "required": ["ok"],
        "properties": {"ok": {"type": "boolean"}},
    }
    captured = []
    monkeypatch.setenv("LLM_GATEWAY_OPENAI_BASE_URL", "http://gateway.test/v1")
    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_ADAPTER_ENABLED", "true")
    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_KIMI", "true")

    def call_gateway(component, gateway_model, messages, **kwargs):
        captured.append({
            "component": component,
            "gateway_model": gateway_model,
            "messages": messages,
            **kwargs,
        })
        return {
            "content": '{"ok":true}',
            "reasoning_content": "The result satisfies the schema.",
            "tool_calls": [],
            "metadata": {"model": "kimi-k3"},
        }

    monkeypatch.setattr(adapter, "_call_gateway_chat", call_gateway)
    original_generate = DaprChatClient.generate
    had_patch_marker = hasattr(DaprChatClient, "_gateway_patched")
    original_patch_marker = getattr(DaprChatClient, "_gateway_patched", None)
    if had_patch_marker:
        delattr(DaprChatClient, "_gateway_patched")
    try:
        client = DaprChatClient(component_name="llm-kimi-k3")
        client._llm_component = "llm-kimi-k3"
        client._reasoning_effort = "low"
        client._response_json_schema = schema
        adapter.patch_for_gateway(client)
        response = client.generate([{"role": "user", "content": "Decide."}])
        client._structured_output_mode = "tool"
        client.generate([{"role": "user", "content": "Decide again."}])
    finally:
        DaprChatClient.generate = original_generate
        if had_patch_marker:
            DaprChatClient._gateway_patched = original_patch_marker
        elif hasattr(DaprChatClient, "_gateway_patched"):
            delattr(DaprChatClient, "_gateway_patched")

    assert captured[0]["native_json_schema"] == schema
    assert captured[0]["structured_output_tool"] is False
    assert captured[0]["gateway_model"] == "kimi-k3"
    assert captured[0]["reasoning_effort"] == "low"
    assert captured[1]["native_json_schema"] == schema
    assert captured[1]["structured_output_tool"] is True
    assert captured[1]["reasoning_effort"] == "low"
    stored = response.get_message().model_dump()
    assert stored["content"] == '{"ok":true}'
    assert stored["reasoning_content"] == "The result satisfies the schema."


def test_glm_52_gateway_disables_thinking_for_tool_calls(monkeypatch) -> None:
    requests = []
    monkeypatch.setenv("LLM_GATEWAY_OPENAI_BASE_URL", "http://gateway.test/v1/")

    def urlopen(req, timeout: int):
        requests.append(req)
        return _Response({
            "id": "chatcmpl_test",
            "choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_gateway_chat(
        "llm-glm-5.2",
        "glm-5.2",
        [{"role": "user", "content": "edit the file"}],
        tools=[{
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write a file",
                "parameters": {"type": "object", "properties": {}},
            },
        }],
    )

    assert result["content"] == "ok"
    assert requests[0].full_url == "http://gateway.test/v1/chat/completions"
    assert requests[0].get_header("Authorization") is None
    body = json.loads(requests[0].data)
    assert body["model"] == "glm-5.2"
    assert body["thinking"] == {"type": "disabled"}


def test_gateway_chat_retries_transient_503_with_backoff(monkeypatch) -> None:
    calls = 0
    sleeps: list[float] = []

    monkeypatch.setenv("LLM_GATEWAY_OPENAI_BASE_URL", "http://gateway.test/v1")
    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_TRANSIENT_RETRIES", "2")
    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_TRANSIENT_INITIAL_BACKOFF_SECONDS", "0.25")
    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_TRANSIENT_MAX_BACKOFF_SECONDS", "1")
    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_TRANSIENT_JITTER_FRACTION", "0")
    monkeypatch.setattr(adapter.time, "sleep", lambda value: sleeps.append(value))

    def urlopen(req, timeout: int):
        nonlocal calls
        calls += 1
        if calls <= 2:
            raise HTTPError(
                req.full_url,
                503,
                "busy",
                {},
                BytesIO(b'{"detail":"Service is too busy"}'),
            )
        return _Response({
            "id": "chatcmpl_test",
            "choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2},
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_gateway_chat(
        "llm-deepseek-v4-pro",
        "deepseek-v4-pro",
        [{"role": "user", "content": "hello"}],
    )

    assert calls == 3
    assert sleeps == [0.25, 0.5]
    assert result["content"] == "ok"
    assert result["metadata"]["model"] == "deepseek-v4-pro"
    assert "route" not in result["metadata"]


def test_gateway_chat_uses_retry_after_for_transient_503(monkeypatch) -> None:
    calls = 0
    sleeps: list[float] = []

    monkeypatch.setenv("LLM_GATEWAY_OPENAI_BASE_URL", "http://gateway.test/v1")
    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_TRANSIENT_RETRIES", "1")
    monkeypatch.setattr(adapter.time, "sleep", lambda value: sleeps.append(value))

    def urlopen(req, timeout: int):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise HTTPError(
                req.full_url,
                503,
                "busy",
                {"Retry-After": "0.75"},
                BytesIO(b'{"detail":"Service is too busy"}'),
            )
        return _Response({
            "id": "chatcmpl_test",
            "choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_gateway_chat(
        "llm-deepseek-v4-pro",
        "deepseek-v4-pro",
        [{"role": "user", "content": "hello"}],
    )

    assert calls == 2
    assert sleeps == [0.75]


def test_gateway_chat_raises_after_transient_retry_budget(monkeypatch) -> None:
    calls = 0
    sleeps: list[float] = []

    monkeypatch.setenv("LLM_GATEWAY_OPENAI_BASE_URL", "http://gateway.test/v1")
    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_TRANSIENT_RETRIES", "1")
    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_TRANSIENT_INITIAL_BACKOFF_SECONDS", "0.25")
    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_TRANSIENT_JITTER_FRACTION", "0")
    monkeypatch.setattr(adapter.time, "sleep", lambda value: sleeps.append(value))

    def urlopen(req, timeout: int):
        nonlocal calls
        calls += 1
        raise HTTPError(
            req.full_url,
            503,
            "busy",
            {},
            BytesIO(b'{"detail":"Service is too busy"}'),
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    try:
        adapter._call_gateway_chat(
            "llm-deepseek-v4-pro",
            "deepseek-v4-pro",
            [{"role": "user", "content": "hello"}],
        )
    except RuntimeError as exc:
        assert (
            "OpenAI-compatible gateway returned HTTP 503 for model=deepseek-v4-pro"
            in str(exc)
        )
    else:
        raise AssertionError("Expected exhausted transient 503 retry budget to raise")

    assert calls == 2
    assert sleeps == [0.25]
