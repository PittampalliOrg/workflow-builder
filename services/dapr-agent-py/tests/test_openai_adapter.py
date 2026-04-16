from __future__ import annotations

import importlib
import io
import json
import os
import sys
from urllib.error import HTTPError

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


def test_openai_oauth_permission_failure_retries_with_api_key(monkeypatch) -> None:
    calls: list[str] = []

    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(
        adapter,
        "_auth_headers",
        lambda: ({"Authorization": "Bearer oauth-token"}, "openai-oauth"),
    )

    def urlopen(req, timeout: int):
        calls.append(req.headers["Authorization"])
        if len(calls) == 1:
            raise HTTPError(
                req.full_url,
                401,
                "Unauthorized",
                {},
                io.BytesIO(
                    b'{"error":{"message":"Missing scopes: api.responses.write"}}'
                ),
            )
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

    assert calls == ["Bearer oauth-token", "Bearer sk-test"]
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
