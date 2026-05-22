from __future__ import annotations

import json
import logging
import os
import hashlib
import time
from urllib.parse import quote
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

import requests

logger = logging.getLogger(__name__)

_TRACING_INITIALIZED = False
SESSION_ID_ATTRIBUTE = "session.id"
WORKFLOW_EXECUTION_ATTRIBUTE = "workflow.execution.id"
WORKFLOW_ACTIVITY_ATTRIBUTE = "workflow.activity.correlation_id"
MLFLOW_FINALIZE_ROOT_SPAN_ENV = "WORKFLOW_ORCHESTRATOR_MLFLOW_FINALIZE_ROOT_SPAN"

WORKFLOW_ACTIVITY_BAGGAGE_KEYS = (
    WORKFLOW_ACTIVITY_ATTRIBUTE,
    "workflow.node.id",
    "workflow.node.name",
    "workflow.node.sequence",
    "workflow.node.action_type",
    WORKFLOW_EXECUTION_ATTRIBUTE,
    "workflow.id",
    SESSION_ID_ATTRIBUTE,
)
_BAGGAGE_VALUE_SAFE_CHARS = "!#$%&'()*+-./:<=>?@[]^_`{|}~"


def _parse_headers(value: str | None) -> dict[str, str] | None:
    if not value:
        return None
    out: dict[str, str] = {}
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k = k.strip()
        v = v.strip()
        if k:
            out[k] = v
    return out or None


def _parse_baggage_header(value: str | None) -> dict[str, str]:
    if not value:
        return {}
    out: dict[str, str] = {}
    for part in value.split(","):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        key = k.strip()
        value_part = v.strip()
        if key:
            out[key] = value_part
    return out


def _format_baggage_header(values: dict[str, Any]) -> str:
    parts: list[str] = []
    for key, raw_value in values.items():
        if not key or raw_value is None:
            continue
        value = str(raw_value).strip()
        if not value:
            continue
        parts.append(f"{key}={quote(value, safe=_BAGGAGE_VALUE_SAFE_CHARS)}")
    return ",".join(parts)


def workflow_activity_attrs_from_carrier(
    carrier: dict[str, Any] | None,
) -> dict[str, Any]:
    """Extract canonical workflow activity attributes from a W3C carrier."""
    if not isinstance(carrier, dict):
        return {}
    baggage = carrier.get("baggage")
    baggage_map = _parse_baggage_header(baggage if isinstance(baggage, str) else None)
    attrs: dict[str, Any] = {}
    for key in WORKFLOW_ACTIVITY_BAGGAGE_KEYS:
        value = carrier.get(key)
        if value is None:
            value = baggage_map.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            attrs[key] = text
    return attrs


def merge_workflow_activity_context(
    carrier: dict[str, Any] | None,
    attributes: dict[str, Any] | None,
) -> dict[str, str]:
    """Return an OTel carrier with semantic workflow activity baggage merged in.

    This deliberately preserves the engine-owned trace fields. Dapr task IDs are
    correlated from durabletask spans after the fact; the propagated carrier only
    holds semantic workflow/node identity.
    """
    base = carrier if isinstance(carrier, dict) else {}
    out: dict[str, str] = {}
    for key in ("traceparent", "tracestate", "traceId", "trace_id", "parentTraceId"):
        value = base.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()

    merged_baggage = _parse_baggage_header(
        base.get("baggage") if isinstance(base.get("baggage"), str) else None
    )
    for key, raw_value in (attributes or {}).items():
        if key not in WORKFLOW_ACTIVITY_BAGGAGE_KEYS:
            continue
        if raw_value is None:
            continue
        value = str(raw_value).strip()
        if value:
            merged_baggage[key] = value
            out[key] = value
    baggage_header = _format_baggage_header(merged_baggage)
    if baggage_header:
        out["baggage"] = baggage_header
    return out


def _otlp_endpoint_for(signal: str) -> str:
    base = (os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip().rstrip("/")
    if not base:
        return ""
    if base.endswith(f"/v1/{signal}"):
        return base
    return f"{base}/v1/{signal}"


def _mlflow_otlp_endpoint_for(signal: str) -> str:
    explicit = (
        os.getenv("WORKFLOW_ORCHESTRATOR_MLFLOW_OTLP_ENDPOINT") or ""
    ).strip().rstrip("/")
    if explicit:
        if explicit.endswith(f"/v1/{signal}"):
            return explicit
        return f"{explicit}/v1/{signal}"
    tracking_uri = (os.getenv("MLFLOW_TRACKING_URI") or "").strip().rstrip("/")
    if not tracking_uri:
        return _otlp_endpoint_for(signal)
    return f"{tracking_uri}/v1/{signal}"


def _env_bool(name: str, default: bool = False) -> bool:
    raw = (os.getenv(name) or "").strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "y", "on"}:
        return True
    if raw in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _parse_resource_attributes(value: str | None) -> dict[str, str]:
    # OTEL_RESOURCE_ATTRIBUTES uses comma-separated key=value.
    if not value:
        return {}
    out: dict[str, str] = {}
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k = k.strip()
        v = v.strip()
        if k:
            out[k] = v
    return out


def _clean_hex_id(value: object, length: int) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower().removeprefix("tr-").replace("-", "")
    if len(normalized) != length:
        return None
    if not all(c in "0123456789abcdef" for c in normalized):
        return None
    if int(normalized, 16) == 0:
        return None
    return normalized


def extract_otel_trace_id(carrier: dict[str, Any] | None) -> str | None:
    """Extract a valid 32-hex trace ID from a lightweight OTel carrier."""
    if not isinstance(carrier, dict):
        return None
    explicit = _clean_hex_id(carrier.get("traceId") or carrier.get("trace_id"), 32)
    if explicit:
        return explicit
    traceparent = carrier.get("traceparent")
    if isinstance(traceparent, str):
        parts = traceparent.strip().split("-")
        if len(parts) >= 4:
            return _clean_hex_id(parts[1], 32)
    return None


def _deterministic_mlflow_root_span_id(trace_id: str, workflow_instance_id: str) -> bytes:
    seed = f"{trace_id}:{workflow_instance_id}:mlflow-finalize-root".encode("utf-8")
    span_id = hashlib.sha256(seed).digest()[:8]
    if int.from_bytes(span_id, "big") == 0:
        return b"\x00\x00\x00\x00\x00\x00\x00\x01"
    return span_id


def _deterministic_mlflow_node_span_id(
    trace_id: str,
    workflow_instance_id: str,
    node_id: str,
    task_sequence: object,
) -> bytes:
    seed = (
        f"{trace_id}:{workflow_instance_id}:{node_id}:{task_sequence}:"
        "mlflow-workflow-node"
    ).encode("utf-8")
    span_id = hashlib.sha256(seed).digest()[:8]
    if int.from_bytes(span_id, "big") == 0:
        return b"\x00\x00\x00\x00\x00\x00\x00\x01"
    return span_id


def _otlp_any_value(value: Any):
    from opentelemetry.proto.common.v1 import common_pb2

    if isinstance(value, bool):
        return common_pb2.AnyValue(bool_value=value)
    if isinstance(value, int) and not isinstance(value, bool):
        return common_pb2.AnyValue(int_value=value)
    if isinstance(value, float):
        return common_pb2.AnyValue(double_value=value)
    return common_pb2.AnyValue(string_value=str(value))


def _otlp_key_value(key: str, value: Any):
    from opentelemetry.proto.common.v1 import common_pb2

    return common_pb2.KeyValue(key=key, value=_otlp_any_value(value))


def _clean_otlp_attributes(attrs: dict[str, Any]) -> list[Any]:
    return [
        _otlp_key_value(key, value)
        for key, value in attrs.items()
        if key and value is not None and str(value).strip()
    ]


def _coerce_epoch_ns(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _post_otlp_span(
    *,
    span: Any,
    scope_name: str,
    scope_version: str = "1.0.0",
    experiment_id: str | None = None,
) -> dict[str, Any]:
    from opentelemetry.proto.collector.trace.v1 import trace_service_pb2
    from opentelemetry.proto.common.v1 import common_pb2
    from opentelemetry.proto.resource.v1 import resource_pb2
    from opentelemetry.proto.trace.v1 import trace_pb2

    endpoint = _mlflow_otlp_endpoint_for("traces")
    if not endpoint:
        return {"success": True, "skipped": True, "reason": "missing_endpoint"}

    resource_attrs = _parse_resource_attributes(os.getenv("OTEL_RESOURCE_ATTRIBUTES"))
    resource_attrs.setdefault(
        "service.name",
        os.getenv("OTEL_SERVICE_NAME") or "workflow-orchestrator",
    )

    request = trace_service_pb2.ExportTraceServiceRequest(
        resource_spans=[
            trace_pb2.ResourceSpans(
                resource=resource_pb2.Resource(
                    attributes=_clean_otlp_attributes(resource_attrs)
                ),
                scope_spans=[
                    trace_pb2.ScopeSpans(
                        scope=common_pb2.InstrumentationScope(
                            name=scope_name,
                            version=scope_version,
                        ),
                        spans=[span],
                    )
                ],
            )
        ]
    )
    headers = _parse_headers(os.getenv("OTEL_EXPORTER_OTLP_HEADERS")) or {}
    headers.setdefault("Content-Type", "application/x-protobuf")
    selected_experiment_id = (
        experiment_id
        or os.getenv("MLFLOW_TRACE_EXPERIMENT_ID")
        or os.getenv("MLFLOW_EXPERIMENT_ID")
        or ""
    ).strip()
    if selected_experiment_id:
        headers.setdefault("x-mlflow-experiment-id", selected_experiment_id)
    timeout_seconds = max(
        1.0,
        float(
            os.getenv(
                "WORKFLOW_ORCHESTRATOR_MLFLOW_FINALIZE_TIMEOUT_SECONDS",
                "10",
            )
        ),
    )
    response = requests.post(
        endpoint,
        data=request.SerializeToString(),
        headers=headers,
        timeout=timeout_seconds,
    )
    if response.status_code >= 400:
        return {
            "success": False,
            "error": (
                f"OTLP export failed: HTTP {response.status_code} "
                f"{response.text[:500]}"
            ),
            "endpoint": endpoint,
        }
    return {"success": True, "endpoint": endpoint}


def emit_mlflow_trace_root_span(input_data: dict[str, Any]) -> dict[str, Any]:
    """Emit one synthetic OTLP root span so MLflow finalizes the workflow trace.

    This is intentionally independent from the SDK tracer provider: MLflow needs
    a root span with the existing trace ID, while Dapr workflow/activity spans are
    otherwise emitted as children. All failures are returned, never raised.
    """
    if not _env_bool(MLFLOW_FINALIZE_ROOT_SPAN_ENV, True):
        return {"success": True, "skipped": True, "reason": "disabled"}

    if not _otlp_endpoint_for("traces"):
        return {"success": True, "skipped": True, "reason": "missing_endpoint"}

    carrier = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    trace_id = _clean_hex_id(input_data.get("traceId"), 32) or extract_otel_trace_id(
        carrier
    )
    if not trace_id:
        return {"success": True, "skipped": True, "reason": "missing_or_invalid_trace_id"}

    workflow_instance_id = str(
        input_data.get("daprInstanceId")
        or input_data.get("workflowInstanceId")
        or input_data.get("executionId")
        or ""
    ).strip()
    if not workflow_instance_id:
        return {
            "success": True,
            "skipped": True,
            "reason": "missing_workflow_instance_id",
        }

    status_text = str(
        input_data.get("status") or input_data.get("statusCode") or "OK"
    ).upper()
    is_error = status_text in {"ERROR", "FAILED", "FAILURE", "EXCEPTION"}
    otlp_status = "ERROR" if is_error else "OK"

    workflow_id = str(input_data.get("workflowId") or "").strip()
    workflow_name = str(
        input_data.get("workflowName") or workflow_id or "workflow"
    ).strip()
    execution_id = str(input_data.get("executionId") or "").strip()
    db_execution_id = str(input_data.get("dbExecutionId") or "").strip()
    display_execution_id = db_execution_id or execution_id or workflow_instance_id
    trace_name = str(input_data.get("traceName") or "").strip()
    if not trace_name:
        trace_name = (
            f"{workflow_id}/{display_execution_id}"
            if workflow_id
            else display_execution_id
        )
    mlflow_context = (
        input_data.get("mlflowContext")
        if isinstance(input_data.get("mlflowContext"), dict)
        else {}
    )
    trace_experiment_id = str(
        mlflow_context.get("traceExperimentId")
        or mlflow_context.get("experimentId")
        or ""
    ).strip() or None

    span_name = str(input_data.get("spanName") or "").strip() or "workflow.finalize"
    error_message = str(input_data.get("error") or "").strip()
    duration_ms = input_data.get("durationMs")
    now_ns = time.time_ns()
    start_ns = _coerce_epoch_ns(input_data.get("startTimeUnixNano"))
    end_ns = _coerce_epoch_ns(input_data.get("endTimeUnixNano"))
    if start_ns is None and input_data.get("startTimeMs") is not None:
        start_ms = _coerce_epoch_ns(input_data.get("startTimeMs"))
        start_ns = start_ms * 1_000_000 if start_ms is not None else None
    if end_ns is None and input_data.get("endTimeMs") is not None:
        end_ms = _coerce_epoch_ns(input_data.get("endTimeMs"))
        end_ns = end_ms * 1_000_000 if end_ms is not None else None
    if start_ns is None and duration_ms is not None:
        try:
            start_ns = now_ns - max(0, int(duration_ms)) * 1_000_000
        except (TypeError, ValueError):
            start_ns = None
    if start_ns is None:
        start_ns = now_ns
    if end_ns is None or end_ns < start_ns:
        end_ns = max(start_ns + 1_000_000, now_ns)

    try:
        from opentelemetry.proto.trace.v1 import trace_pb2

        span_attrs: dict[str, Any] = {
            "gen_ai.operation.name": "workflow",
            "mlflow.spanType": "AGENT",
            "mlflow.traceName": trace_name,
            "workflow.id": workflow_id,
            "workflow.name": workflow_name,
            "workflow.execution.id": display_execution_id,
            "workflow_builder.trace_group_id": display_execution_id,
            "workflow.execution.db_id": db_execution_id,
            "dapr.workflow.instance_id": workflow_instance_id,
            "dapr.workflow.name": workflow_name,
            "status": otlp_status,
            "workflow.status": otlp_status,
            "workflow.duration_ms": duration_ms,
            "mlflow.run_id": mlflow_context.get("runId"),
            "mlflow.parent_run_id": mlflow_context.get("parentRunId"),
            "mlflow.modelId": mlflow_context.get("activeModelId"),
            "mlflow.model.uri": mlflow_context.get("activeModelUri"),
        }
        if error_message:
            span_attrs["error.message"] = error_message

        span = trace_pb2.Span(
            trace_id=bytes.fromhex(trace_id),
            span_id=_deterministic_mlflow_root_span_id(trace_id, workflow_instance_id),
            name=span_name,
            kind=trace_pb2.Span.SPAN_KIND_INTERNAL,
            start_time_unix_nano=start_ns,
            end_time_unix_nano=end_ns,
            attributes=_clean_otlp_attributes(span_attrs),
            status=trace_pb2.Status(
                code=(
                    trace_pb2.Status.STATUS_CODE_ERROR
                    if is_error
                    else trace_pb2.Status.STATUS_CODE_OK
                ),
                message=error_message if is_error else "",
            ),
        )

        post_result = _post_otlp_span(
            span=span,
            scope_name="workflow-orchestrator.mlflow-finalizer",
            experiment_id=trace_experiment_id,
        )
        if post_result.get("skipped"):
            return {**post_result, "traceId": trace_id}
        if not post_result.get("success"):
            return {**post_result, "traceId": trace_id}
        return {
            "success": True,
            "traceId": trace_id,
            "spanId": span.span_id.hex(),
            "status": otlp_status,
            "endpoint": post_result.get("endpoint"),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("[Tracing] MLflow root span finalization failed: %s", exc)
        return {"success": False, "error": str(exc), "traceId": trace_id}


def emit_mlflow_workflow_node_span(input_data: dict[str, Any]) -> dict[str, Any]:
    """Emit one raw OTLP span for a completed workflow node."""
    carrier = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    trace_id = _clean_hex_id(input_data.get("traceId"), 32) or extract_otel_trace_id(
        carrier
    )
    if not trace_id:
        return {"success": True, "skipped": True, "reason": "missing_or_invalid_trace_id"}

    workflow_instance_id = str(
        input_data.get("daprInstanceId")
        or input_data.get("workflowInstanceId")
        or input_data.get("executionId")
        or ""
    ).strip()
    node_id = str(input_data.get("nodeId") or "").strip()
    if not workflow_instance_id:
        return {
            "success": True,
            "skipped": True,
            "reason": "missing_workflow_instance_id",
        }
    if not node_id:
        return {"success": True, "skipped": True, "reason": "missing_node_id"}

    status_text = str(input_data.get("status") or "OK").upper()
    is_error = status_text in {"ERROR", "FAILED", "FAILURE", "EXCEPTION"}
    otlp_status = "ERROR" if is_error else "OK"
    duration_ms = input_data.get("durationMs")
    try:
        duration_ns = max(0, int(duration_ms or 0)) * 1_000_000
    except (TypeError, ValueError):
        duration_ns = 0
    end_ns = time.time_ns()
    start_ns = max(0, end_ns - duration_ns) if duration_ns else end_ns

    workflow_id = str(input_data.get("workflowId") or "").strip()
    workflow_name = str(input_data.get("workflowName") or workflow_id or "").strip()
    db_execution_id = str(input_data.get("dbExecutionId") or "").strip()
    display_execution_id = db_execution_id or str(input_data.get("executionId") or "").strip()
    node_name = str(input_data.get("nodeName") or node_id).strip()
    error_message = str(input_data.get("error") or "").strip()
    result_size = input_data.get("resultSizeChars")
    task_sequence = input_data.get("taskSequence")
    mlflow_context = (
        input_data.get("mlflowContext")
        if isinstance(input_data.get("mlflowContext"), dict)
        else {}
    )
    trace_experiment_id = str(
        mlflow_context.get("traceExperimentId")
        or mlflow_context.get("experimentId")
        or ""
    ).strip() or None

    try:
        from opentelemetry.proto.trace.v1 import trace_pb2

        span_attrs: dict[str, Any] = {
            "gen_ai.operation.name": "workflow.node",
            "mlflow.spanType": "CHAIN",
            WORKFLOW_ACTIVITY_ATTRIBUTE: input_data.get("activityCorrelationId"),
            "workflow.id": workflow_id,
            "workflow.name": workflow_name,
            "workflow.execution.id": display_execution_id,
            "workflow.execution.db_id": db_execution_id,
            "dapr.workflow.instance_id": workflow_instance_id,
            "workflow.node.id": node_id,
            "workflow.node.name": node_name,
            "workflow.node.type": input_data.get("nodeType"),
            "workflow.node.action_type": input_data.get("actionType"),
            "workflow.node.sequence": task_sequence,
            "workflow.node.status": otlp_status,
            "workflow.node.duration_ms": duration_ms,
            "workflow.node.result_size_chars": result_size,
            "status": otlp_status,
        }
        if error_message:
            span_attrs["error.message"] = error_message

        span = trace_pb2.Span(
            trace_id=bytes.fromhex(trace_id),
            span_id=_deterministic_mlflow_node_span_id(
                trace_id,
                workflow_instance_id,
                node_id,
                task_sequence,
            ),
            parent_span_id=_deterministic_mlflow_root_span_id(
                trace_id,
                workflow_instance_id,
            ),
            name=f"workflow.node.{node_id}",
            kind=trace_pb2.Span.SPAN_KIND_INTERNAL,
            start_time_unix_nano=start_ns,
            end_time_unix_nano=end_ns,
            attributes=_clean_otlp_attributes(span_attrs),
            status=trace_pb2.Status(
                code=(
                    trace_pb2.Status.STATUS_CODE_ERROR
                    if is_error
                    else trace_pb2.Status.STATUS_CODE_OK
                ),
                message=error_message if is_error else "",
            ),
        )
        post_result = _post_otlp_span(
            span=span,
            scope_name="workflow-orchestrator.mlflow-node-spans",
            experiment_id=trace_experiment_id,
        )
        if post_result.get("skipped"):
            return {**post_result, "traceId": trace_id}
        if not post_result.get("success"):
            return {**post_result, "traceId": trace_id}
        return {
            "success": True,
            "traceId": trace_id,
            "spanId": span.span_id.hex(),
            "parentSpanId": span.parent_span_id.hex(),
            "status": otlp_status,
            "endpoint": post_result.get("endpoint"),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("[Tracing] MLflow workflow node span export failed: %s", exc)
        return {"success": False, "error": str(exc), "traceId": trace_id}


class JsonTraceFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }

        trace_id = getattr(record, "trace_id", None)
        span_id = getattr(record, "span_id", None)
        if trace_id:
            payload["trace_id"] = trace_id
        if span_id:
            payload["span_id"] = span_id

        # Preserve any structured context attached via logger extra=...
        extra = getattr(record, "extra", None)
        if isinstance(extra, dict):
            payload.update(extra)

        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)

        return json.dumps(payload, ensure_ascii=True)


class TraceContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            from opentelemetry import trace as ot_trace
            from opentelemetry import baggage as ot_baggage

            span = ot_trace.get_current_span()
            if span:
                ctx = span.get_span_context()
                if ctx and ctx.trace_id:
                    record.trace_id = f"{ctx.trace_id:032x}"
                    record.span_id = f"{ctx.span_id:016x}"
            session_id = workflow_session_id(
                ot_baggage.get_baggage(SESSION_ID_ATTRIBUTE)
                or ot_baggage.get_baggage("sessionId")
                or ot_baggage.get_baggage("session_id")
                or ot_baggage.get_baggage(WORKFLOW_EXECUTION_ATTRIBUTE)
            )
            if session_id:
                record.__dict__[SESSION_ID_ATTRIBUTE] = session_id
                record.__dict__[WORKFLOW_EXECUTION_ATTRIBUTE] = session_id
        except Exception:
            pass
        return True


def _init_mlflow_destination() -> None:
    """Optionally add MLflow as a span destination on the active TracerProvider.

    No-op when `mlflow` isn't installed or when
    `MLFLOW_TRACKING_URI`/`MLFLOW_TRACE_EXPERIMENT_ID` aren't set.
    Failures are logged but never raise — tracing must stay best-effort.

    Workflow-orchestrator should normally rely on the replay-safe raw OTLP
    finalizer/node-span path for MLflow. The SDK destination exports ordinary
    OTel spans and has produced invalid `span_type=None` attributes in the
    collector path, so keep it opt-in only.
    """
    if os.environ.get("WORKFLOW_ORCHESTRATOR_MLFLOW_SDK_DESTINATION", "false").strip().lower() not in {
        "1",
        "true",
        "yes",
        "on",
    }:
        logger.info("[Tracing] MLflow SDK destination skipped (raw OTLP finalizer mode)")
        return

    tracking_uri = (os.environ.get("MLFLOW_TRACKING_URI") or "").strip()
    experiment_id = (os.environ.get("MLFLOW_TRACE_EXPERIMENT_ID") or "").strip()
    if not tracking_uri or not experiment_id:
        logger.info(
            "[Tracing] MLflow destination skipped "
            "(MLFLOW_TRACKING_URI=%r, MLFLOW_TRACE_EXPERIMENT_ID=%r)",
            tracking_uri or "<unset>",
            experiment_id or "<unset>",
        )
        return

    try:
        import mlflow
        from mlflow.entities.trace_location import MlflowExperimentLocation
    except Exception as exc:  # noqa: BLE001
        logger.info("[Tracing] mlflow SDK unavailable; MLflow destination skipped (%s)", exc)
        return

    try:
        mlflow.set_tracking_uri(tracking_uri)
        mlflow.tracing.set_destination(MlflowExperimentLocation(experiment_id=experiment_id))
        logger.info(
            "[Tracing] MLflow destination set: experiment_id=%s tracking_uri=%s",
            experiment_id,
            tracking_uri,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[Tracing] Failed to set MLflow destination: %s", exc)
        return

    # Provider-level autolog is tied to the optional SDK destination. Keep it
    # off by default for the orchestrator; dapr-agent-py owns LLM/tool spans.
    if os.environ.get("WORKFLOW_ORCHESTRATOR_MLFLOW_AUTOLOG", "true").strip().lower() not in {
        "0", "false", "no", "off"
    }:
        try:
            import mlflow.anthropic  # type: ignore[import-not-found]
            mlflow.anthropic.autolog(log_traces=True, silent=True)
            logger.info("[Tracing] MLflow Anthropic autolog enabled (Phase 2b)")
        except Exception as exc:  # noqa: BLE001
            logger.info("[Tracing] MLflow Anthropic autolog skipped (%s)", exc)
        try:
            import mlflow.litellm  # type: ignore[import-not-found]
            mlflow.litellm.autolog(log_traces=True, silent=True)
            logger.info("[Tracing] MLflow LiteLLM autolog enabled (Phase 2b/2c)")
        except Exception as exc:  # noqa: BLE001
            logger.info("[Tracing] MLflow LiteLLM autolog skipped (%s)", exc)


def setup_logging_json(otel_handler: logging.Handler | None = None) -> None:
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)

    handler = logging.StreamHandler()
    handler.setFormatter(JsonTraceFormatter())
    handler.addFilter(TraceContextFilter())
    root.addHandler(handler)
    if otel_handler is not None:
        otel_handler.addFilter(TraceContextFilter())
        root.addHandler(otel_handler)


def setup_tracing(service_name: str, app: Any | None = None) -> bool:
    """
    Initialize OpenTelemetry (traces + metrics) and enable log/trace correlation.

    This is opt-in: if OTEL_EXPORTER_OTLP_ENDPOINT is not set, we do not start.
    """
    global _TRACING_INITIALIZED
    if _TRACING_INITIALIZED:
        return True

    endpoint = (os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()
    if not endpoint:
        logger.info("[Tracing] OTEL_EXPORTER_OTLP_ENDPOINT not set; tracing disabled")
        _TRACING_INITIALIZED = True
        return False

    try:
        from opentelemetry import metrics, trace
        from opentelemetry import _logs as ot_logs
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
            OTLPMetricExporter,
        )
        from opentelemetry.exporter.otlp.proto.http._log_exporter import (
            OTLPLogExporter,
        )
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        from opentelemetry.instrumentation.logging import LoggingInstrumentor
        from opentelemetry.instrumentation.requests import RequestsInstrumentor
        from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
        from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except Exception as e:
        logger.warning(f"[Tracing] Failed to import OpenTelemetry packages: {e}")
        _TRACING_INITIALIZED = True
        return False

    headers = _parse_headers(os.getenv("OTEL_EXPORTER_OTLP_HEADERS"))

    resource_attrs = _parse_resource_attributes(os.getenv("OTEL_RESOURCE_ATTRIBUTES"))
    resource_attrs.setdefault("service.name", os.getenv("OTEL_SERVICE_NAME") or service_name)

    resource = Resource.create(resource_attrs)

    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(
                endpoint=_otlp_endpoint_for("traces"),
                headers=headers,
            )
        )
    )
    trace.set_tracer_provider(tracer_provider)

    # Add MLflow as an ADDITIONAL span destination on the same TP. The
    # OTEL Collector path (BatchSpanProcessor above) keeps sending to
    # ClickHouse + Tempo; MLflow's `set_destination()` adds a processor
    # that writes trace_request_metadata so traces are searchable via
    # mlflow.search_traces() and visible in the MLflow UI. The
    # otlphttp/mlflow collector exporter alone doesn't write that
    # metadata — see project_mlflow_otlp_search_gap.md memory.
    os.environ.setdefault("MLFLOW_USE_DEFAULT_TRACER_PROVIDER", "false")
    _init_mlflow_destination()

    metric_reader = PeriodicExportingMetricReader(
        OTLPMetricExporter(
            endpoint=_otlp_endpoint_for("metrics"),
            headers=headers,
        )
    )
    meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
    metrics.set_meter_provider(meter_provider)

    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(
        BatchLogRecordProcessor(
            OTLPLogExporter(
                endpoint=_otlp_endpoint_for("logs"),
                headers=headers,
            )
        )
    )
    ot_logs.set_logger_provider(logger_provider)
    otel_handler = LoggingHandler(
        level=logging.NOTSET,
        logger_provider=logger_provider,
    )

    # Auto instrumentation for inbound/outbound HTTP.
    RequestsInstrumentor().instrument()
    HTTPXClientInstrumentor().instrument()
    LoggingInstrumentor().instrument(set_logging_format=False)
    if app is not None:
        try:
            FastAPIInstrumentor.instrument_app(app)
        except Exception as e:
            logger.debug(f"[Tracing] FastAPI instrumentation failed: {e}")

    setup_logging_json(otel_handler)

    _TRACING_INITIALIZED = True
    logger.info("[Tracing] OpenTelemetry enabled (OTLP HTTP)")
    return True


def inject_current_context() -> dict[str, str]:
    """
    Serialize the current trace context into a simple carrier dict.
    """
    try:
        from opentelemetry.propagate import inject

        carrier: dict[str, str] = {}
        inject(carrier)
        # We only care about w3c headers today.
        filtered = {
            k: v
            for k, v in carrier.items()
            if k in ("traceparent", "tracestate", "baggage")
        }
        if filtered.get("traceparent"):
            return filtered

        from opentelemetry import trace as ot_trace

        span = ot_trace.get_current_span()
        ctx = span.get_span_context() if span else None
        if ctx and ctx.is_valid:
            filtered["traceparent"] = (
                f"00-{ctx.trace_id:032x}-{ctx.span_id:016x}-01"
            )
        return filtered
    except Exception:
        return {}


def workflow_session_id(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def extract_session_id(carrier: dict[str, Any] | None) -> str | None:
    if not isinstance(carrier, dict):
        return None
    explicit = workflow_session_id(
        carrier.get("sessionId")
        or carrier.get("session_id")
        or carrier.get(SESSION_ID_ATTRIBUTE)
        or carrier.get("x-workflow-session-id")
    )
    if explicit:
        return explicit
    baggage = carrier.get("baggage")
    if isinstance(baggage, str):
        baggage_map = _parse_baggage_header(baggage)
        return workflow_session_id(
            baggage_map.get(SESSION_ID_ATTRIBUTE)
            or baggage_map.get(WORKFLOW_EXECUTION_ATTRIBUTE)
        )
    return None


def attach_workflow_session(span: Any, session_id: str | None) -> None:
    if not span or not session_id:
        return
    try:
        span.set_attribute(SESSION_ID_ATTRIBUTE, session_id)
        span.set_attribute(WORKFLOW_EXECUTION_ATTRIBUTE, session_id)
    except Exception:
        pass
    # Promote to MLflow trace tags so search filters work
    # (Phase 1 of research-the-most-popular-stateful-hinton.md).
    # `update_current_trace` is a no-op when MLflow SDK isn't initialised
    # (e.g. unit-test contexts), so the call is best-effort and never
    # raises.
    set_mlflow_trace_tags({
        SESSION_ID_ATTRIBUTE: session_id,
        WORKFLOW_EXECUTION_ATTRIBUTE: session_id,
        "dapr.workflow.instance_id": session_id,
    })


def set_mlflow_trace_tags(
    tags: dict[str, Any],
    *,
    trace_name: str | None = None,
    trace_id_hex: str | None = None,
) -> None:
    """Promote a curated tag dict onto the active MLflow trace.

    Two-stage approach because MLflow's `update_current_trace()` only
    works when an MLflow-managed tracing context is active — which it
    isn't for spans created via the bare OTel `tracer.start_as_current_span`
    API (our case for Dapr workflow activities). The warning
    "No active trace found" surfaces when called without that context.

    Strategy:
      1. Try `mlflow.update_current_trace(...)` — cheap, works for
         `@mlflow.trace`-decorated paths.
      2. ALSO call `MlflowClient().set_trace_tag(trace_id, k, v)` per
         tag using the OTel-derived trace_id (translated to MLflow's
         `tr-<hex>` format).

    If `trace_name` is provided, ALSO set the `mlflow.traceName` tag —
    this is what MLflow's Traces UI shows as the trace's display name
    in the list. Phase 4 of plan research-the-most-popular-stateful-hinton.md
    uses this to render workflow-aware trace names like
    `workflow.async-coding-task/<exec-id>` instead of the default
    `create_orchestration||sw_workflow_v1||1.0.0`.

    Best-effort: silent no-op when mlflow isn't installed or no OTel
    span is active. Skips empty/None values. Strings only.
    """
    if not tags and not trace_name:
        return
    tags = dict(tags or {})
    clean = {
        k: str(v).strip()
        for k, v in tags.items()
        if v is not None and isinstance(v, (str, int, float))
        and str(v).strip()
    }
    if not clean:
        return
    try:
        import mlflow  # type: ignore[import-not-found]
    except Exception:
        return
    session_id = clean.pop("session.id", None)

    # `mlflow.traceName` is the magic tag key MLflow's UI reads as the
    # trace's display name. Adding it here so update_current_trace
    # flushes it along with the other tags — critical at workflow
    # entry where the trace_info row doesn't exist yet and the
    # set_trace_tag fallback would fail with FK violation.
    update_tags = dict(clean)
    if trace_name:
        update_tags["mlflow.traceName"] = str(trace_name).strip()

    # The orchestrator uses plain OTel spans plus raw OTLP finalizer spans,
    # not MLflow-managed spans. Calling the fluent API here usually logs
    # "No active trace found", so keep it opt-in for local experiments.
    if os.environ.get("WORKFLOW_ORCHESTRATOR_MLFLOW_FLUENT_TAGS", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }:
        try:
            if session_id:
                mlflow.update_current_trace(tags=update_tags, session_id=session_id)
            else:
                mlflow.update_current_trace(tags=update_tags)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[Tracing] update_current_trace failed (will fall back to set_trace_tag): %s", exc)

    # Always also call set_trace_tag via the OTel-derived trace_id,
    # OR an explicit `trace_id_hex` provided by the caller. The explicit
    # path is needed in Dapr workflow function contexts where no OTel
    # span is active when the call fires (workflow entry runs outside
    # `start_activity_span`); the caller already has `tc.trace_id`
    # parsed from the W3C carrier and passes it through.
    try:
        explicit_hex: str | None = None
        if trace_id_hex:
            explicit_hex = trace_id_hex.strip().lower().lstrip("tr-").replace("-", "")
            if len(explicit_hex) != 32 or not all(c in "0123456789abcdef" for c in explicit_hex):
                explicit_hex = None
        if explicit_hex is None:
            from opentelemetry import trace as ot_trace
            span = ot_trace.get_current_span()
            if span is None:
                return
            ctx = span.get_span_context()
            if not ctx or ctx.trace_id == 0:
                return
            explicit_hex = format(ctx.trace_id, "032x")
        mlflow_trace_id = f"tr-{explicit_hex}"
        client = mlflow.MlflowClient()
        if session_id:
            clean["session.id"] = session_id

        # Retry helper for set_trace_tag. At workflow entry the
        # trace_info row may not be committed yet (OTel span flushed but
        # MLflow's async export queue is still draining) — FK violation
        # `fk_trace_tags_request_id`. Retry with short backoff so we
        # block at most ~1.5s before giving up.
        import time as _time
        def _set_with_retry(k: str, v: str) -> None:
            for attempt in range(6):
                try:
                    client.set_trace_tag(mlflow_trace_id, k, v)
                    return
                except Exception as exc:  # noqa: BLE001
                    err_str = str(exc)
                    if (
                        ("ForeignKeyViolation" in err_str or "trace_info" in err_str)
                        and attempt < 5
                    ):
                        _time.sleep(0.25 * (attempt + 1))
                        continue
                    logger.debug(
                        "[Tracing] client.set_trace_tag(%s)=%s failed: %s",
                        k, v, exc,
                    )
                    return

        for k, v in clean.items():
            _set_with_retry(k, v)
        if trace_name:
            _set_with_retry("mlflow.traceName", str(trace_name).strip())
    except Exception as exc:  # noqa: BLE001
        logger.debug("[Tracing] set_trace_tag fallback path failed: %s", exc)


def _extract_context(carrier: dict[str, str] | None):
    try:
        from opentelemetry.propagate import extract

        return extract(carrier or {})
    except Exception:
        return None


@contextmanager
def start_activity_span(
    name: str,
    carrier: dict[str, str] | None,
    attributes: dict[str, Any] | None = None,
):
    try:
        from opentelemetry import trace as ot_trace

        tracer = ot_trace.get_tracer("workflow-orchestrator")
        parent_ctx = _extract_context(carrier)
    except Exception:
        # Fallback mode: run without tracing context.
        yield None
        return

    with tracer.start_as_current_span(name, context=parent_ctx) as span:
        attach_workflow_session(span, extract_session_id(carrier))
        if attributes:
            for k, v in attributes.items():
                if v is None:
                    continue
                try:
                    span.set_attribute(k, v)
                except Exception:
                    pass
        yield span


def apply_workflow_activity_context(
    carrier: dict[str, Any] | None,
    attributes: dict[str, Any] | None = None,
) -> dict[str, str]:
    """Stamp workflow activity attrs on the active span and return merged carrier."""
    merged = merge_workflow_activity_context(carrier, attributes)
    span_attrs = workflow_activity_attrs_from_carrier(merged)
    if attributes:
        span_attrs.update(
            {
                key: value
                for key, value in attributes.items()
                if key in WORKFLOW_ACTIVITY_BAGGAGE_KEYS and value is not None
            }
        )
    set_current_span_attrs(span_attrs)
    return merged


def set_current_span_attrs(attributes: dict[str, Any] | None) -> None:
    """Stamp attributes onto the **currently active** OTel span.

    Used by Dapr activity bodies to enrich the outer
    `activity||<name>` span the durabletask runtime creates around them.
    Best-effort: no active span / no OTel install → silent no-op.
    None / empty-string / empty-list values are skipped automatically.

    Convenience over calling `trace.get_current_span().set_attribute()`
    directly: defends against the no-op `INVALID_SPAN` sentinel + handles
    list/tuple/None coercion in one place.
    """
    if not attributes:
        return
    try:
        from opentelemetry import trace as ot_trace
    except Exception:
        return
    try:
        span = ot_trace.get_current_span()
    except Exception:
        return
    if span is None:
        return
    try:
        sc = span.get_span_context()
        if sc is None or getattr(sc, "trace_id", 0) == 0:
            return
    except Exception:
        return
    for k, v in attributes.items():
        if v is None:
            continue
        if isinstance(v, str) and not v:
            continue
        if isinstance(v, (list, tuple)) and not v:
            continue
        try:
            span.set_attribute(str(k), v)
        except Exception:
            pass
