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


def test_glm_52_route_requires_zai_feature_flag(monkeypatch) -> None:
    monkeypatch.setenv("MLFLOW_AI_GATEWAY_BASE_URL", "http://gateway.test")
    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_ADAPTER_ENABLED", "true")
    monkeypatch.delenv("DAPR_AGENT_PY_GATEWAY_ZAI", raising=False)

    assert adapter._route_for_component("llm-glm-5.2") is None

    monkeypatch.setenv("DAPR_AGENT_PY_GATEWAY_ZAI", "true")
    assert adapter._provider_for_component("llm-glm-5.2") == "zai"
    assert adapter._route_for_component("llm-glm-5.2") == "glm-5.2"


def test_glm_52_gateway_disables_thinking_for_tool_calls(monkeypatch) -> None:
    bodies: list[dict] = []
    monkeypatch.setenv("MLFLOW_AI_GATEWAY_BASE_URL", "http://gateway.test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data))
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
    assert bodies[0]["model"] == "glm-5.2"
    assert bodies[0]["thinking"] == {"type": "disabled"}


def test_gateway_chat_retries_transient_503_with_backoff(monkeypatch) -> None:
    calls = 0
    sleeps: list[float] = []

    monkeypatch.setenv("MLFLOW_AI_GATEWAY_BASE_URL", "http://gateway.test")
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
    assert result["metadata"]["route"] == "deepseek-v4-pro"


def test_gateway_chat_uses_retry_after_for_transient_503(monkeypatch) -> None:
    calls = 0
    sleeps: list[float] = []

    monkeypatch.setenv("MLFLOW_AI_GATEWAY_BASE_URL", "http://gateway.test")
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

    monkeypatch.setenv("MLFLOW_AI_GATEWAY_BASE_URL", "http://gateway.test")
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
        assert "MLflow AI Gateway returned HTTP 503 for route=deepseek-v4-pro" in str(exc)
    else:
        raise AssertionError("Expected exhausted transient 503 retry budget to raise")

    assert calls == 2
    assert sleeps == [0.25]
