from __future__ import annotations

import importlib
from io import BytesIO
import json
import os
import sys
from urllib.error import HTTPError

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
