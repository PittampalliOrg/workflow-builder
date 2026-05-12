from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import tracing
from opentelemetry.proto.collector.trace.v1 import trace_service_pb2
from opentelemetry.proto.trace.v1 import trace_pb2


class _FakeResponse:
    def __init__(self, status_code: int = 200, text: str = "ok"):
        self.status_code = status_code
        self.text = text


def _attribute_map(span):
    attrs = {}
    for item in span.attributes:
        value = item.value
        field = value.WhichOneof("value")
        attrs[item.key] = getattr(value, field)
    return attrs


def test_emit_mlflow_trace_root_span_posts_expected_otlp_request(monkeypatch):
    trace_id = "1234567890abcdef1234567890abcdef"
    captured = {}

    def fake_post(url, data, headers, timeout):
        captured.update(
            {
                "url": url,
                "data": data,
                "headers": headers,
                "timeout": timeout,
            }
        )
        return _FakeResponse()

    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_HEADERS", raising=False)
    monkeypatch.setattr(tracing.requests, "post", fake_post)

    result = tracing.emit_mlflow_trace_root_span(
        {
            "_otel": {"traceId": trace_id},
            "workflowId": "wf_test",
            "workflowName": "Test Workflow",
            "executionId": "exec_123",
            "dbExecutionId": "db_exec_123",
            "daprInstanceId": "dapr_wf_123",
            "traceName": "wf_test/db_exec_123",
            "status": "OK",
        }
    )

    assert result["success"] is True
    assert captured["url"] == "http://collector:4318/v1/traces"
    assert captured["headers"]["Content-Type"] == "application/x-protobuf"

    request = trace_service_pb2.ExportTraceServiceRequest()
    request.ParseFromString(captured["data"])
    span = request.resource_spans[0].scope_spans[0].spans[0]
    assert span.trace_id == bytes.fromhex(trace_id)
    assert span.parent_span_id == b""
    assert span.span_id == tracing._deterministic_mlflow_root_span_id(
        trace_id,
        "dapr_wf_123",
    )
    assert span.span_id != b"\x00" * 8
    assert span.status.code == trace_pb2.Status.STATUS_CODE_OK

    attrs = _attribute_map(span)
    assert attrs["gen_ai.operation.name"] == "workflow"
    assert attrs["mlflow.spanType"] == "AGENT"
    assert attrs["workflow.id"] == "wf_test"
    assert attrs["workflow.execution.id"] == "db_exec_123"
    assert attrs["dapr.workflow.instance_id"] == "dapr_wf_123"
    assert attrs["mlflow.traceName"] == "wf_test/db_exec_123"


def test_emit_mlflow_trace_root_span_sets_error_status(monkeypatch):
    trace_id = "abcdefabcdefabcdefabcdefabcdefab"
    captured = {}

    def fake_post(_url, data, headers, timeout):
        _ = headers, timeout
        captured["data"] = data
        return _FakeResponse()

    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318/v1/traces")
    monkeypatch.setattr(tracing.requests, "post", fake_post)

    result = tracing.emit_mlflow_trace_root_span(
        {
            "_otel": {"traceparent": f"00-{trace_id}-1234567890abcdef-01"},
            "workflowId": "wf_test",
            "executionId": "exec_123",
            "daprInstanceId": "dapr_wf_123",
            "status": "ERROR",
            "error": "forced failure",
        }
    )

    assert result["success"] is True
    request = trace_service_pb2.ExportTraceServiceRequest()
    request.ParseFromString(captured["data"])
    span = request.resource_spans[0].scope_spans[0].spans[0]
    assert span.status.code == trace_pb2.Status.STATUS_CODE_ERROR
    assert span.status.message == "forced failure"
    assert _attribute_map(span)["error.message"] == "forced failure"


def test_emit_mlflow_trace_root_span_skips_missing_inputs(monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    assert tracing.emit_mlflow_trace_root_span({"_otel": {"traceId": "1" * 32}}) == {
        "success": True,
        "skipped": True,
        "reason": "missing_endpoint",
    }

    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")
    missing_trace = tracing.emit_mlflow_trace_root_span(
        {"daprInstanceId": "dapr_wf_123"}
    )
    assert missing_trace["skipped"] is True
    assert missing_trace["reason"] == "missing_or_invalid_trace_id"

    invalid_trace = tracing.emit_mlflow_trace_root_span(
        {"_otel": {"traceId": "not-a-trace"}, "daprInstanceId": "dapr_wf_123"}
    )
    assert invalid_trace["skipped"] is True
    assert invalid_trace["reason"] == "missing_or_invalid_trace_id"


def test_emit_mlflow_trace_root_span_reports_http_failures(monkeypatch):
    def fake_post(*_args, **_kwargs):
        return _FakeResponse(status_code=503, text="collector unavailable")

    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")
    monkeypatch.setattr(tracing.requests, "post", fake_post)

    result = tracing.emit_mlflow_trace_root_span(
        {
            "_otel": {"traceId": "1" * 32},
            "daprInstanceId": "dapr_wf_123",
        }
    )

    assert result["success"] is False
    assert "HTTP 503" in result["error"]


def test_emit_mlflow_trace_root_span_catches_transport_errors(monkeypatch):
    def fake_post(*_args, **_kwargs):
        raise RuntimeError("network down")

    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")
    monkeypatch.setattr(tracing.requests, "post", fake_post)

    result = tracing.emit_mlflow_trace_root_span(
        {
            "_otel": {"traceId": "1" * 32},
            "daprInstanceId": "dapr_wf_123",
        }
    )

    assert result["success"] is False
    assert "network down" in result["error"]


def test_sanitizing_span_exporter_removes_invalid_attributes():
    from opentelemetry.sdk.trace import Event, ReadableSpan

    captured = {}

    class FakeExporter:
        def export(self, spans):
            captured["span_attrs"] = dict(spans[0].attributes)
            captured["event_attrs"] = dict(spans[0].events[0].attributes)
            return "ok"

        def shutdown(self):
            captured["shutdown"] = True

        def force_flush(self, timeout_millis=30000):
            captured["flush_timeout"] = timeout_millis
            return True

    span = ReadableSpan(
        name="bad",
        attributes={
            "span_type": None,
            "ok": "yes",
            "zero": 0,
            "false": False,
            "items": ["a", None, "b"],
        },
        events=(
            Event(
                "event",
                attributes={"event_bad": None, "event_ok": 1},
            ),
        ),
    )

    exporter = tracing._SanitizingSpanExporter(FakeExporter())

    assert exporter.export([span]) == "ok"
    assert "span_type" not in captured["span_attrs"]
    assert captured["span_attrs"]["ok"] == "yes"
    assert captured["span_attrs"]["zero"] == 0
    assert captured["span_attrs"]["false"] is False
    assert captured["span_attrs"]["items"] == ["a", "b"]
    assert "event_bad" not in captured["event_attrs"]
    assert captured["event_attrs"]["event_ok"] == 1
    assert exporter.force_flush(123) is True
    assert captured["flush_timeout"] == 123
