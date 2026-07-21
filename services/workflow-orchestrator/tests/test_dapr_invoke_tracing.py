from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class _FakeSpan:
    def __init__(self):
        self.attributes = {}
        self.ended = False

    def set_attribute(self, key, value):
        self.attributes[key] = value

    def record_exception(self, _exc):
        return None

    def set_status(self, _status):
        return None

    def end(self):
        self.ended = True


class _FakeTracer:
    def __init__(self, span):
        self.span = span

    def start_span(self, _name):
        return self.span


class _FakeResponse:
    def text(self):
        return json.dumps({"ok": True, "token": "server-secret"})


class _FakeDaprClient:
    last_kwargs = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def invoke_method(self, **kwargs):
        type(self).last_kwargs = kwargs
        return _FakeResponse()


def test_dapr_invoke_stamps_service_graph_io_attrs(monkeypatch):
    from activities import dapr_invoke
    from opentelemetry import trace

    span = _FakeSpan()
    monkeypatch.setattr(dapr_invoke, "DaprClient", _FakeDaprClient)
    monkeypatch.setattr(trace, "get_tracer", lambda _name: _FakeTracer(span))
    monkeypatch.setenv("ENABLE_REQUEST_CONTENT_TRACING", "true")

    status, body, raw = dapr_invoke.dapr_invoke(
        "function-router",
        "execute",
        {"command": "echo hi", "apiKey": "client-secret"},
    )

    assert status == 200
    assert body == {"ok": True, "token": "server-secret"}
    assert raw == '{"ok": true, "token": "server-secret"}'
    assert span.ended is True
    assert span.attributes["dapr.target_service"] == "function-router"
    assert span.attributes["dapr.method"] == "execute"
    assert span.attributes["http.response.status_code"] == 200

    input_value = json.loads(span.attributes["input.value"])
    output_value = json.loads(span.attributes["output.value"])
    assert input_value == {
        "app_id": "function-router",
        "method": "execute",
        "body": {"command": "echo hi", "apiKey": "[REDACTED]"},
    }
    assert output_value == {
        "status": 200,
        "body": {"ok": True, "token": "[REDACTED]"},
    }


def test_dapr_invoke_uses_trace_override_without_changing_transport(monkeypatch):
    from activities import dapr_invoke
    from opentelemetry import trace

    span = _FakeSpan()
    _FakeDaprClient.last_kwargs = None
    monkeypatch.setattr(dapr_invoke, "DaprClient", _FakeDaprClient)
    monkeypatch.setattr(trace, "get_tracer", lambda _name: _FakeTracer(span))
    monkeypatch.setenv("ENABLE_REQUEST_CONTENT_TRACING", "true")

    raw_payload = {
        "function_slug": "workspace/materialize-files",
        "input": {
            "files": [
                {
                    "path": "/sandbox/app/index.html",
                    "content": "private source",
                }
            ]
        },
    }
    safe_payload = {
        "function_slug": "workspace/materialize-files",
        "input": {
            "fileCount": 1,
            "files": [{"path": "/sandbox/app/index.html"}],
        },
    }
    status, _, _ = dapr_invoke.dapr_invoke(
        "function-router",
        "execute",
        raw_payload,
        trace_payload=safe_payload,
    )

    assert status == 200
    traced = json.loads(span.attributes["input.value"])
    assert "private source" not in json.dumps(traced)
    assert traced["body"] == safe_payload
    assert json.loads(_FakeDaprClient.last_kwargs["data"]) == raw_payload
