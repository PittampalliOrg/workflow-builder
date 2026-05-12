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

    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://mlflow:5000")
    monkeypatch.setenv("MLFLOW_TRACE_EXPERIMENT_ID", "3")
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
            "durationMs": 1234,
            "startTimeMs": 1_700_000_000_000,
            "endTimeMs": 1_700_000_001_234,
        }
    )

    assert result["success"] is True
    assert captured["url"] == "http://mlflow:5000/v1/traces"
    assert captured["headers"]["Content-Type"] == "application/x-protobuf"
    assert captured["headers"]["x-mlflow-experiment-id"] == "3"

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
    assert span.start_time_unix_nano == 1_700_000_000_000_000_000
    assert span.end_time_unix_nano == 1_700_000_001_234_000_000

    attrs = _attribute_map(span)
    assert attrs["gen_ai.operation.name"] == "workflow"
    assert attrs["mlflow.spanType"] == "AGENT"
    assert attrs["workflow.id"] == "wf_test"
    assert attrs["workflow.execution.id"] == "db_exec_123"
    assert attrs["dapr.workflow.instance_id"] == "dapr_wf_123"
    assert attrs["mlflow.traceName"] == "wf_test/db_exec_123"
    assert attrs["workflow.status"] == "OK"
    assert attrs["workflow.duration_ms"] == 1234


def test_emit_mlflow_trace_root_span_sets_error_status(monkeypatch):
    trace_id = "abcdefabcdefabcdefabcdefabcdefab"
    captured = {}

    def fake_post(_url, data, headers, timeout):
        _ = headers, timeout
        captured["data"] = data
        return _FakeResponse()

    monkeypatch.setenv(
        "WORKFLOW_ORCHESTRATOR_MLFLOW_OTLP_ENDPOINT",
        "http://mlflow:5000/v1/traces",
    )
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
    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    monkeypatch.delenv("WORKFLOW_ORCHESTRATOR_MLFLOW_OTLP_ENDPOINT", raising=False)
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

    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://mlflow:5000")
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

    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://mlflow:5000")
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


def test_emit_mlflow_workflow_node_span_posts_child_chain_span(monkeypatch):
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

    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://mlflow:5000")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")
    monkeypatch.setattr(tracing.requests, "post", fake_post)

    result = tracing.emit_mlflow_workflow_node_span(
        {
            "_otel": {"traceId": trace_id},
            "workflowId": "wf_test",
            "workflowName": "Test Workflow",
            "executionId": "dapr_wf_123",
            "dbExecutionId": "db_exec_123",
            "daprInstanceId": "dapr_wf_123",
            "nodeId": "agent_step",
            "nodeName": "Agent Step",
            "nodeType": "call",
            "actionType": "durable/run",
            "taskSequence": 2,
            "durationMs": 456,
            "resultSizeChars": 789,
            "status": "OK",
        }
    )

    assert result["success"] is True
    assert captured["url"] == "http://mlflow:5000/v1/traces"
    request = trace_service_pb2.ExportTraceServiceRequest()
    request.ParseFromString(captured["data"])
    span = request.resource_spans[0].scope_spans[0].spans[0]
    assert span.trace_id == bytes.fromhex(trace_id)
    assert span.span_id == tracing._deterministic_mlflow_node_span_id(
        trace_id,
        "dapr_wf_123",
        "agent_step",
        2,
    )
    assert span.span_id != b"\x00" * 8
    assert span.parent_span_id == tracing._deterministic_mlflow_root_span_id(
        trace_id,
        "dapr_wf_123",
    )
    assert span.name == "workflow.node.agent_step"
    assert span.status.code == trace_pb2.Status.STATUS_CODE_OK

    attrs = _attribute_map(span)
    assert attrs["gen_ai.operation.name"] == "workflow.node"
    assert attrs["mlflow.spanType"] == "CHAIN"
    assert attrs["workflow.id"] == "wf_test"
    assert attrs["workflow.execution.id"] == "db_exec_123"
    assert attrs["workflow.node.id"] == "agent_step"
    assert attrs["workflow.node.status"] == "OK"
    assert attrs["workflow.node.duration_ms"] == 456
    assert attrs["workflow.node.result_size_chars"] == 789


def test_emit_mlflow_workflow_node_span_sets_error_status(monkeypatch):
    trace_id = "abcdefabcdefabcdefabcdefabcdefab"
    captured = {}

    def fake_post(_url, data, headers, timeout):
        _ = headers, timeout
        captured["data"] = data
        return _FakeResponse()

    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://mlflow:5000")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")
    monkeypatch.setattr(tracing.requests, "post", fake_post)

    result = tracing.emit_mlflow_workflow_node_span(
        {
            "_otel": {"traceId": trace_id},
            "daprInstanceId": "dapr_wf_123",
            "nodeId": "bad_step",
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
