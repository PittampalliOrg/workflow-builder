from __future__ import annotations

import sys
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Some workflow tests install minimal google.protobuf stubs for app import
# isolation. Remove those stubs before importing the real OTLP protobuf types.
protobuf_module = sys.modules.get("google.protobuf")
if protobuf_module is not None and not hasattr(protobuf_module, "descriptor"):
    for module_name in list(sys.modules):
        if module_name == "google" or module_name.startswith("google.protobuf"):
            del sys.modules[module_name]

import tracing
from opentelemetry.proto.collector.trace.v1 import trace_service_pb2
from opentelemetry.proto.trace.v1 import trace_pb2

FINALIZER_PATH = ROOT / "activities" / "finalize_mlflow_trace_root.py"
FINALIZER_SPEC = importlib.util.spec_from_file_location(
    "finalize_mlflow_trace_root_for_tests",
    FINALIZER_PATH,
)
assert FINALIZER_SPEC is not None and FINALIZER_SPEC.loader is not None
finalizer = importlib.util.module_from_spec(FINALIZER_SPEC)
FINALIZER_SPEC.loader.exec_module(finalizer)


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
    assert attrs["workflow_builder.trace_group_id"] == "db_exec_123"
    assert attrs["dapr.workflow.instance_id"] == "dapr_wf_123"
    assert attrs["mlflow.traceName"] == "wf_test/db_exec_123"
    assert attrs["workflow.status"] == "OK"
    assert attrs["workflow.duration_ms"] == 1234


def test_emit_mlflow_trace_root_span_prefers_context_experiment(monkeypatch):
    captured = {}

    def fake_post(url, data, headers, timeout):
        captured.update({"url": url, "headers": headers})
        return _FakeResponse()

    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://mlflow:5000")
    monkeypatch.setenv("MLFLOW_TRACE_EXPERIMENT_ID", "legacy-global")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318")
    monkeypatch.setattr(tracing.requests, "post", fake_post)

    result = tracing.emit_mlflow_trace_root_span(
        {
            "_otel": {"traceId": "1234567890abcdef1234567890abcdef"},
            "workflowId": "wf_test",
            "executionId": "exec_123",
            "daprInstanceId": "dapr_wf_123",
            "mlflowContext": {"traceExperimentId": "per-workflow-11"},
        }
    )

    assert result["success"] is True
    assert captured["headers"]["x-mlflow-experiment-id"] == "per-workflow-11"


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


def test_finalize_activity_links_trace_to_parent_and_child_runs(monkeypatch):
    trace_id = "1234567890abcdef1234567890abcdef"
    targets = [
        {
            "entity_type": "workflow_execution",
            "entity_id": "db_exec_123",
            "project_id": "project_1",
            "experiment_id": "8",
            "run_id": "parent_run",
        },
        {
            "entity_type": "session",
            "entity_id": "session_1",
            "project_id": "project_1",
            "experiment_id": "8",
            "run_id": "child_run",
        },
    ]
    linked = []
    recorded = {}

    monkeypatch.setenv("MLFLOW_ENABLED", "true")
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://mlflow:5000")
    monkeypatch.setattr(
        finalizer,
        "_fetch_mlflow_run_targets",
        lambda db_execution_id: targets if db_execution_id == "db_exec_123" else [],
    )
    monkeypatch.setattr(
        finalizer,
        "_link_trace_to_run",
        lambda mlflow_trace_id, run_id: linked.append((mlflow_trace_id, run_id)) or True,
    )

    def fake_record_lineage_links(*, trace_id, targets):
        recorded["trace_id"] = trace_id
        recorded["run_ids"] = [target["run_id"] for target in targets]

    monkeypatch.setattr(finalizer, "_record_lineage_links", fake_record_lineage_links)
    monkeypatch.setattr(
        finalizer,
        "_reconcile_related_traces",
        lambda **_kwargs: {"relatedTraceCount": 0, "relatedTraceIds": []},
    )

    result = finalizer._link_trace_to_workflow_runs(
        {"traceId": trace_id, "dbExecutionId": "db_exec_123"}
    )

    assert result["linked"] is True
    assert result["traceId"] == f"tr-{trace_id}"
    assert result["linkedRunIds"] == ["parent_run", "child_run"]
    assert linked == [(f"tr-{trace_id}", "parent_run"), (f"tr-{trace_id}", "child_run")]
    assert recorded == {
        "trace_id": f"tr-{trace_id}",
        "run_ids": ["parent_run", "child_run"],
    }


def test_reconcile_related_traces_records_matching_trace_sources(monkeypatch):
    calls = []
    targets = [
        {
            "entity_type": "workflow_execution",
            "entity_id": "db_exec_123",
            "project_id": "project_1",
            "experiment_id": "8",
            "run_id": "parent_run",
        },
        {
            "entity_type": "session",
            "entity_id": "session_1",
            "project_id": "project_1",
            "experiment_id": "8",
            "run_id": "child_run",
        },
    ]

    monkeypatch.setattr(
        finalizer,
        "_search_related_mlflow_traces",
        lambda **_kwargs: [
            {
                "trace_id": "tr-1234567890abcdef1234567890abcdef",
                "attrs": {"workflow.execution.id": "db_exec_123"},
            },
            {
                "trace_id": "tr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "attrs": {"session.id": "session_1", "service.name": "agent-runtime-demo"},
            },
            {
                "trace_id": "tr-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "attrs": {
                    "workflow.execution.id": "db_exec_123",
                    "service.name": "daprd",
                },
            },
        ],
    )

    def fake_record_lineage_links(*, trace_id, targets, source="primary", attrs=None):
        calls.append(
            {
                "trace_id": trace_id,
                "target_count": len(targets),
                "source": source,
                "attrs": attrs,
            }
        )

    monkeypatch.setattr(finalizer, "_record_lineage_links", fake_record_lineage_links)

    result = finalizer._reconcile_related_traces(
        input_data={
            "traceId": "1234567890abcdef1234567890abcdef",
            "dbExecutionId": "db_exec_123",
            "workflowId": "workflow_1",
            "daprInstanceId": "dapr_wf_123",
            "mlflowContext": {"traceExperimentId": "8"},
        },
        primary_trace_id="tr-1234567890abcdef1234567890abcdef",
        targets=targets,
    )

    assert result["relatedTraceCount"] == 3
    assert [call["source"] for call in calls] == [
        "primary",
        "agent_session",
        "dapr_sidecar",
    ]


def test_link_trace_to_run_posts_mlflow_link_endpoint(monkeypatch):
    captured = {}

    def fake_post(url, json, timeout):
        captured.update({"url": url, "json": json, "timeout": timeout})
        return _FakeResponse(status_code=200, text="{}")

    monkeypatch.setenv("MLFLOW_ENABLED", "true")
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://mlflow:5000/")
    monkeypatch.setattr(finalizer.requests, "post", fake_post)

    assert finalizer._link_trace_to_run("tr-abc", "run_123") is True
    assert captured == {
        "url": "http://mlflow:5000/api/2.0/mlflow/traces/link-to-run",
        "json": {"trace_ids": ["tr-abc"], "run_id": "run_123"},
        "timeout": 5,
    }


def test_finalize_activity_returns_trace_link_result(monkeypatch):
    monkeypatch.setattr(
        finalizer,
        "emit_mlflow_trace_root_span",
        lambda _input_data: {"success": True, "traceId": "1234567890abcdef1234567890abcdef"},
    )
    monkeypatch.setattr(
        finalizer,
        "_link_trace_to_workflow_runs",
        lambda _input_data: {"linked": True, "linkedRunIds": ["run_123"]},
    )

    result = finalizer.finalize_mlflow_trace_root(
        None,
        {"traceId": "1234567890abcdef1234567890abcdef", "dbExecutionId": "db_exec_123"},
    )

    assert result["success"] is True
    assert result["traceLink"] == {"linked": True, "linkedRunIds": ["run_123"]}
