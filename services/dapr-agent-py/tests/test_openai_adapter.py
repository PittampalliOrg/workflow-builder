from __future__ import annotations

import importlib
import json
import os
import sys

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

adapter = importlib.import_module("src.openai_adapter")


class _Response:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode()


def test_openai_auth_headers_use_api_key_only(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    assert adapter._auth_headers() == (
        {"Authorization": "Bearer sk-test"},
        "openai-api-key",
    )


def test_openai_auth_headers_require_api_key(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    try:
        adapter._auth_headers()
    except RuntimeError as exc:
        assert str(exc) == "No OpenAI authentication configured. Set OPENAI_API_KEY."
    else:
        raise AssertionError("Expected missing OPENAI_API_KEY to raise RuntimeError")


def test_openai_responses_uses_api_key(monkeypatch) -> None:
    calls: list[str] = []

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(
        adapter,
        "_auth_headers",
        lambda: ({"Authorization": "Bearer sk-test"}, "openai-api-key"),
    )

    def urlopen(req, timeout: int):
        calls.append(req.headers["Authorization"])
        return _Response({
            "id": "resp_test",
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": "ok"}],
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_openai_responses(
        "llm-openai-gpt5",
        [{"role": "user", "content": "hello"}],
        None,
    )

    assert calls == ["Bearer sk-test"]
    assert result["content"] == "ok"
    assert result["metadata"]["auth_mode"] == "openai-api-key"


def test_response_format_schema_is_sent_as_strict_json_schema(monkeypatch) -> None:
    bodies: list[dict] = []

    class ConversationSummary:
        __name__ = "ConversationSummary"

        @staticmethod
        def model_json_schema() -> dict:
            return {
                "type": "object",
                "properties": {
                    "summary": {"type": "string"},
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"name": {"type": "string"}},
                        },
                    },
                },
            }

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(
        adapter,
        "_auth_headers",
        lambda: ({"Authorization": "Bearer sk-test"}, "openai-api-key"),
    )

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response({
            "id": "resp_test",
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": "{}"}],
            }],
        })

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_openai_responses(
        "llm-openai-gpt5",
        [{"role": "user", "content": "summarize"}],
        None,
        response_format=ConversationSummary,
    )

    schema_format = bodies[0]["text"]["format"]
    schema = schema_format["schema"]
    nested_schema = schema["properties"]["items"]["items"]

    assert schema_format["strict"] is True
    assert schema["additionalProperties"] is False
    assert schema["required"] == ["summary", "items"]
    assert nested_schema["additionalProperties"] is False
    assert nested_schema["required"] == ["name"]


def test_openai_llm_usage_event_includes_effective_config_audit_fields(monkeypatch) -> None:
    events: list[tuple[str, str, dict, str | None]] = []
    publisher = importlib.import_module("src.event_publisher")

    monkeypatch.setattr(publisher, "get_scoped_session", lambda: ("sesn_1", "turn_1"))
    monkeypatch.setattr(
        publisher,
        "get_scoped_audit_fields",
        lambda: {
            "modelSpec": "openai/o3",
            "llmComponent": "llm-openai-o3",
            "configRevision": 2,
            "configHash": "abc123",
        },
    )

    def capture(session_id: str, event_type: str, data: dict, *, instance_id=None, **_):
        events.append((session_id, event_type, data, instance_id))

    monkeypatch.setattr(publisher, "publish_session_event", capture)

    adapter._publish_llm_usage(
        model="o3",
        usage={
            "input_tokens": 11,
            "output_tokens": 7,
            "input_tokens_details": {"cached_tokens": 3},
        },
        ttft_ms=42.5,
        success=True,
    )

    assert events == [
        (
            "sesn_1",
            "agent.llm_usage",
            {
                "model": "o3",
                "modelSpec": "openai/o3",
                "llmComponent": "llm-openai-o3",
                "configRevision": 2,
                "configHash": "abc123",
                "input_tokens": 11,
                "output_tokens": 7,
                "cache_read_input_tokens": 3,
                "cache_creation_input_tokens": 0,
                "ttft_ms": 42.5,
                "recovery_attempts": 0,
                "success": True,
            },
            "turn_1",
        )
    ]
