"""
Workflow Orchestrator Service

A Python microservice that runs the Dapr Workflow Runtime for executing
workflow definitions from the visual workflow builder.

Architecture:
- FastAPI HTTP server for REST API endpoints
- Dapr Workflow Runtime for durable workflow execution
- Dapr service invocation to call function-router for OpenFunction execution
- Dapr state store for workflow state persistence
- Dapr pub/sub for event publishing

KEY FEATURE: Native child workflow support for Dapr agent actions via Dapr child workflows.
"""

from __future__ import annotations

import inspect
import json
import logging
import os
import random
import string
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any
from collections.abc import Callable

import grpc
import requests
import durabletask.internal.orchestrator_service_pb2 as pb
import durabletask.internal.orchestrator_service_pb2_grpc as pb_grpc
from dapr.ext.workflow import DaprWorkflowClient
from fastapi.encoders import jsonable_encoder
from fastapi import FastAPI, HTTPException, Request
from google.protobuf import wrappers_pb2
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from core.config import config
from workflows.sw_workflow import sw_workflow
from workflows.sw_workflow import wfr
from activities.call_agent_service import terminate_durable_runs_by_parent_execution
from activities.metadata import get_activity_metadata

# OpenTelemetry
from tracing import (
    setup_tracing,
    inject_current_context,
    attach_workflow_session,
    extract_session_id,
    workflow_session_id,
)

# Configuration from centralized config module
PORT = config.PORT
HOST = config.HOST
LOG_LEVEL = config.LOG_LEVEL

# Configure logging
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def _otel_context_from_headers(request: Request) -> dict[str, str]:
    carrier: dict[str, str] = {}
    traceparent = request.headers.get("traceparent")
    tracestate = request.headers.get("tracestate")
    baggage = request.headers.get("baggage")
    workflow_session_id_header = request.headers.get("x-workflow-session-id")
    if traceparent:
        carrier["traceparent"] = traceparent
    if tracestate:
        carrier["tracestate"] = tracestate
    if baggage:
        carrier["baggage"] = baggage
    if workflow_session_id_header:
        carrier["x-workflow-session-id"] = workflow_session_id_header
    return carrier


def _current_trace_context() -> dict[str, str]:
    try:
        from opentelemetry import trace as ot_trace

        span = ot_trace.get_current_span()
        if span is None:
            return {}
        span_context = span.get_span_context()
        if span_context is None or not getattr(span_context, "is_valid", False):
            return {}
        return {
            "traceparent": (
                f"00-{span_context.trace_id:032x}-{span_context.span_id:016x}-01"
            ),
            "traceId": f"{span_context.trace_id:032x}",
        }
    except Exception:
        return {}


def _generate_trace_context() -> dict[str, str]:
    trace_id = uuid.uuid4().hex
    span_id = uuid.uuid4().hex[:16]
    return {
        "traceparent": f"00-{trace_id}-{span_id}-01",
        "traceId": trace_id,
    }


def _merge_otel_context(request: Request | None = None) -> dict[str, str]:
    merged = inject_current_context()
    if not merged.get("traceparent"):
        merged.update(_current_trace_context())
    if request is not None:
        merged.update(_otel_context_from_headers(request))
    if not merged.get("traceparent"):
        merged.update(_generate_trace_context())
    if not merged.get("traceId"):
        trace_id = _trace_id_from_traceparent(merged.get("traceparent"))
        if trace_id:
            merged["traceId"] = trace_id
    session_id = extract_session_id(merged)
    if session_id:
        merged["sessionId"] = session_id
        merged["session.id"] = session_id
        merged["workflow.execution.id"] = session_id
    return merged


def _trace_id_from_traceparent(traceparent: object) -> str | None:
    if not isinstance(traceparent, str):
        return None
    parts = traceparent.strip().split("-")
    if len(parts) != 4:
        return None
    trace_id = parts[1].strip().lower()
    if len(trace_id) != 32:
        return None
    try:
        int(trace_id, 16)
    except ValueError:
        return None
    return trace_id


def _is_native_agent_child_workflow_id(workflow_id: object) -> bool:
    if not isinstance(workflow_id, str):
        return False
    return "__msagent__" in workflow_id or "__dapr__" in workflow_id


# --- Runtime capability checks ---

def _parse_semver(version: str | None) -> tuple[int, int, int]:
    text = str(version or "").strip().lstrip("v")
    parts = text.split(".", 2)
    major = int(parts[0]) if len(parts) > 0 and parts[0].isdigit() else 0
    minor = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    patch_part = parts[2] if len(parts) > 2 else "0"
    patch_digits = ""
    for ch in patch_part:
        if ch.isdigit():
            patch_digits += ch
        else:
            break
    patch = int(patch_digits or "0")
    return (major, minor, patch)


def _is_truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _check_min_dapr_runtime_version() -> None:
    """
    Verify sidecar runtime version for workflow features introduced in Dapr 1.17.
    """
    min_version = config.MIN_DAPR_RUNTIME_VERSION
    enforce = _is_truthy(config.ENFORCE_MIN_DAPR_VERSION)
    metadata_url = f"http://{config.DAPR_HOST}:{config.DAPR_HTTP_PORT}/v1.0/metadata"
    try:
        response = requests.get(metadata_url, timeout=5)
        response.raise_for_status()
        payload = response.json() if response.content else {}
        runtime_version = str(payload.get("runtimeVersion") or "")
        if _parse_semver(runtime_version) < _parse_semver(min_version):
            message = (
                "[Workflow Orchestrator] Dapr runtime version "
                f"{runtime_version or '<unknown>'} is below minimum required {min_version}."
            )
            if enforce:
                raise RuntimeError(message)
            logger.warning(message)
        else:
            logger.info(
                "[Workflow Orchestrator] Dapr runtime version %s satisfies minimum %s",
                runtime_version,
                min_version,
            )
    except Exception as e:
        message = (
            "[Workflow Orchestrator] Failed to verify Dapr runtime version "
            f"(minimum {min_version}): {e}"
        )
        if enforce:
            raise RuntimeError(message) from e
        logger.warning(message)


_WORKFLOW_RUNTIME_PROBE_INSTANCE_ID = "__workflow_runtime_probe__"
_TRANSIENT_WORKFLOW_RUNTIME_ERROR_MARKERS = (
    "the state store is not configured to use the actor runtime",
    "socket closed",
    "failed to connect to all addresses",
    "connection refused",
    "workflow engine",
    "statuscode.unavailable",
)


def _get_workflow_runtime_status(timeout_seconds: float = 2.0) -> tuple[bool, dict[str, Any]]:
    """
    Probe the local Dapr sidecar and workflow task hub before serving traffic.
    """
    details: dict[str, Any] = {
        "daprHost": config.DAPR_HOST,
        "daprHttpPort": config.DAPR_HTTP_PORT,
        "daprGrpcPort": config.DAPR_GRPC_PORT,
    }
    errors: list[str] = []

    try:
        health_response = requests.get(
            f"http://{config.DAPR_HOST}:{config.DAPR_HTTP_PORT}/v1.0/healthz/outbound",
            timeout=timeout_seconds,
        )
        details["sidecarOutboundStatusCode"] = health_response.status_code
        details["sidecarOutboundHealthy"] = health_response.ok
        if not health_response.ok:
            errors.append(
                f"sidecar outbound health returned {health_response.status_code}"
            )
    except Exception as exc:
        details["sidecarOutboundHealthy"] = False
        details["sidecarOutboundError"] = str(exc)
        errors.append(f"sidecar outbound health check failed: {exc}")

    try:
        metadata_response = requests.get(
            f"http://{config.DAPR_HOST}:{config.DAPR_HTTP_PORT}/v1.0/metadata",
            timeout=timeout_seconds,
        )
        metadata_response.raise_for_status()
        metadata_payload = metadata_response.json() if metadata_response.content else {}
        details["runtimeVersion"] = metadata_payload.get("runtimeVersion")
        details["appId"] = metadata_payload.get("id")
    except Exception as exc:
        details["metadataError"] = str(exc)
        errors.append(f"metadata probe failed: {exc}")

    try:
        response = _taskhub_call(
            "GetInstance",
            pb.GetInstanceRequest(
                instanceId=_WORKFLOW_RUNTIME_PROBE_INSTANCE_ID,
                getInputsAndOutputs=False,
            ),
        )
        details["taskhubReady"] = True
        details["taskhubProbeExists"] = bool(getattr(response, "exists", False))
    except Exception as exc:
        details["taskhubReady"] = False
        details["taskhubError"] = str(exc)
        errors.append(f"taskhub probe failed: {exc}")

    details["errors"] = errors
    return (len(errors) == 0, details)


def _raise_workflow_route_error(operation: str, error: Exception) -> None:
    """
    Prefer a clear 503 when Dapr workflow runtime is the actual failing dependency.
    """
    error_message = str(error)
    lowered = error_message.lower()
    runtime_ready, runtime_status = _get_workflow_runtime_status(timeout_seconds=1.0)

    if (not runtime_ready) or any(
        marker in lowered for marker in _TRANSIENT_WORKFLOW_RUNTIME_ERROR_MARKERS
    ):
        detail = {
            "code": "workflow_runtime_unavailable",
            "error": "Dapr workflow runtime is not ready",
            "operation": operation,
            "runtimeStatus": runtime_status,
            "rawError": error_message,
        }
        logger.warning(
            "[Workflow Routes] %s failed while workflow runtime unavailable: %s",
            operation,
            detail,
        )
        raise HTTPException(status_code=503, detail=detail)

    raise HTTPException(status_code=500, detail=error_message)


def _is_taskhub_unimplemented_error(error: Exception) -> bool:
    return "unimplemented" in str(error).lower()


# --- TaskHub gRPC helpers (workflow management APIs) ---

_taskhub_channel: grpc.Channel | None = None
_taskhub_stub: pb_grpc.TaskHubSidecarServiceStub | None = None
SW_WORKFLOW_NAME = "sw_workflow_v1"


def _taskhub_metadata() -> list[tuple[str, str]] | None:
    token = str(getattr(config, "DAPR_API_TOKEN", "") or "").strip()
    if token:
        return [("dapr-api-token", token)]
    env_token = str(os.environ.get("DAPR_API_TOKEN") or "").strip()
    if env_token:
        return [("dapr-api-token", env_token)]
    return None


def _get_taskhub_stub() -> pb_grpc.TaskHubSidecarServiceStub:
    global _taskhub_channel, _taskhub_stub
    if _taskhub_stub is not None:
        return _taskhub_stub
    target = f"{config.DAPR_HOST}:{config.DAPR_GRPC_PORT}"
    _taskhub_channel = grpc.insecure_channel(target)
    _taskhub_stub = pb_grpc.TaskHubSidecarServiceStub(_taskhub_channel)
    return _taskhub_stub


def _taskhub_call(method: str, request: Any) -> Any:
    stub = _get_taskhub_stub()
    rpc = getattr(stub, method)
    metadata = _taskhub_metadata()
    timeout_seconds = max(float(config.TASKHUB_RPC_TIMEOUT_SECONDS), 0.1)
    if metadata:
        return rpc(request, metadata=metadata, timeout=timeout_seconds)
    return rpc(request, timeout=timeout_seconds)


def _schedule_new_workflow_instance(
    workflow_name: str,
    instance_id: str,
    workflow_input: dict[str, Any],
    *,
    workflow_version: str | None = None,
    idempotent: bool = False,
    parent_trace_context: dict[str, str] | None = None,
) -> str:
    request = pb.CreateInstanceRequest(
        instanceId=instance_id,
        name=workflow_name,
        input=wrappers_pb2.StringValue(value=json.dumps(workflow_input)),
    )
    # Propagate W3C trace context into the Dapr workflow span tree.
    # The sidecar uses parentTraceContext to connect workflow/activity spans
    # under the caller's trace (Dapr 1.17+ / durabletask-go TraceContext proto).
    if parent_trace_context and parent_trace_context.get("traceparent"):
        trace_ctx = pb.TraceContext(
            traceParent=parent_trace_context["traceparent"],
        )
        trace_state = parent_trace_context.get("tracestate", "")
        if trace_state:
            trace_ctx.traceState.CopyFrom(wrappers_pb2.StringValue(value=trace_state))
        request.parentTraceContext.CopyFrom(trace_ctx)
    if workflow_version:
        request.version.CopyFrom(wrappers_pb2.StringValue(value=workflow_version))
    if idempotent:
        # Use IGNORE policy: if instance already exists and is RUNNING/PENDING,
        # the scheduler returns it without error (atomic dedup, no TOCTOU race).
        request.orchestrationIdReusePolicy.CopyFrom(
            pb.OrchestrationIdReusePolicy(
                operationStatus=[
                    pb.ORCHESTRATION_STATUS_RUNNING,
                    pb.ORCHESTRATION_STATUS_PENDING,
                    pb.ORCHESTRATION_STATUS_SUSPENDED,
                ],
                action=pb.IGNORE,
            )
        )
    response = _taskhub_call("StartInstance", request)
    result_id = str(getattr(response, "instanceId", "") or "").strip()
    if not result_id:
        raise RuntimeError("workflow runtime returned an empty instance ID")
    return result_id


def _idempotent_schedule(
    workflow_name: str,
    instance_id: str,
    workflow_input: dict[str, Any],
    *,
    workflow_version: str | None = None,
    parent_trace_context: dict[str, str] | None = None,
) -> str:
    """Schedule a workflow instance idempotently.

    Uses the Dapr/durabletask ``OrchestrationIdReusePolicy`` with ``IGNORE``
    action for atomic dedup: if the instance already exists and is
    RUNNING/PENDING/SUSPENDED, the scheduler returns the existing ID
    without error (no TOCTOU race condition).

    If the instance is in a terminal state (COMPLETED/FAILED/TERMINATED),
    purge it first, then schedule fresh.
    """
    try:
        return _schedule_new_workflow_instance(
            workflow_name=workflow_name,
            instance_id=instance_id,
            workflow_input=workflow_input,
            workflow_version=workflow_version,
            idempotent=True,
            parent_trace_context=parent_trace_context,
        )
    except Exception as schedule_err:
        # Atomic IGNORE didn't help -- instance may be in terminal state.
        # Try purging and retrying.
        try:
            client = get_workflow_client()
            existing = client.get_workflow_state(
                instance_id=instance_id, fetch_payloads=False
            )
        except Exception:
            existing = None

        if existing is None:
            raise schedule_err

        status_name = str(getattr(existing, "runtime_status", "")).upper()
        logger.info(
            "[Idempotent Schedule] Instance %s exists (status=%s), purging and retrying",
            instance_id,
            status_name,
        )

        if status_name in ("COMPLETED", "FAILED", "TERMINATED"):
            try:
                client.purge_workflow(instance_id=instance_id)
                logger.info("[Idempotent Schedule] Purged terminal instance %s", instance_id)
            except Exception as purge_err:
                logger.warning("[Idempotent Schedule] Purge failed: %s", purge_err)
            return _schedule_new_workflow_instance(
                workflow_name=workflow_name,
                instance_id=instance_id,
                workflow_input=workflow_input,
                workflow_version=workflow_version,
                parent_trace_context=parent_trace_context,
            )

        # Instance is RUNNING/PENDING/SUSPENDED — return existing
        return instance_id


def _clone_json_value(value: Any) -> Any:
    return json.loads(json.dumps(value))


def _build_definition_from_workflow_record(workflow_row: dict[str, Any]) -> dict[str, Any]:
    raw_nodes = workflow_row["nodes"]
    raw_edges = workflow_row["edges"]
    lowered_nodes, lowered_edges = _lower_while_nodes(raw_nodes, raw_edges)

    exec_nodes = [
        n
        for n in lowered_nodes
        if n.get("type") != "add" and n.get("data", {}).get("type") != "add"
    ]
    serialized_nodes = [_serialize_node(n) for n in exec_nodes]
    node_ids = {n["id"] for n in exec_nodes}
    serialized_edges = [
        {
            "id": e["id"],
            "source": e["source"],
            "target": e["target"],
            "sourceHandle": e.get("sourceHandle"),
            "targetHandle": e.get("targetHandle"),
        }
        for e in lowered_edges
        if e["source"] in node_ids and e["target"] in node_ids
    ]
    execution_order = _topological_sort(
        [{"id": n["id"], "type": n["type"]} for n in serialized_nodes],
        serialized_edges,
    )
    now = datetime.now(timezone.utc).isoformat()
    return {
        "id": workflow_row["id"],
        "name": workflow_row["name"],
        "version": "1.0.0",
        "nodes": serialized_nodes,
        "edges": serialized_edges,
        "executionOrder": execution_order,
        "createdAt": now,
        "updatedAt": now,
    }


def _extract_published_runtime(spec: Any) -> dict[str, Any] | None:
    if not isinstance(spec, dict):
        return None
    metadata = spec.get("metadata")
    if not isinstance(metadata, dict):
        return None
    published_runtime = metadata.get("publishedRuntime")
    if not isinstance(published_runtime, dict):
        return None
    if str(published_runtime.get("status") or "").strip().lower() != "published":
        return None
    return published_runtime


def _extract_published_revisions(
    workflow_row: dict[str, Any],
) -> tuple[str | None, str | None, list[dict[str, Any]]]:
    published_runtime = _extract_published_runtime(workflow_row.get("spec"))
    workflow_name = str(
        workflow_row.get("daprWorkflowName")
        or (published_runtime or {}).get("workflowName")
        or ""
    ).strip() or None
    latest_version = str(
        (published_runtime or {}).get("latestVersion") or ""
    ).strip() or None
    revisions_raw = (
        published_runtime.get("revisions")
        if isinstance(published_runtime, dict)
        else None
    )
    revisions: list[dict[str, Any]] = []
    if isinstance(revisions_raw, list):
        for revision in revisions_raw:
            if not isinstance(revision, dict):
                continue
            version = str(revision.get("version") or "").strip()
            definition = revision.get("definition")
            if not version or not isinstance(definition, dict):
                continue
            revisions.append(
                {
                    "version": version,
                    "publishedAt": str(revision.get("publishedAt") or "").strip() or None,
                    "definition": _clone_json_value(definition),
                    "specVersion": str(revision.get("specVersion") or "").strip() or None,
                }
            )
    if workflow_name and latest_version and not revisions:
        revisions.append(
            {
                "version": latest_version,
                "publishedAt": None,
                "definition": _build_definition_from_workflow_record(workflow_row),
                "specVersion": (
                    str(workflow_row.get("specVersion") or "").strip() or None
                ),
            }
        )
    return workflow_name, latest_version, revisions


# --- Lifecycle ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Manage Dapr Workflow Runtime lifecycle.

    Registers workflows and activities, then starts/stops the runtime.
    """
    logger.info("=== Workflow Orchestrator Service (Python) ===")
    logger.info(f"Log Level: {LOG_LEVEL}")

    # Initialize OpenTelemetry (opt-in via OTEL_EXPORTER_OTLP_ENDPOINT).
    setup_tracing("workflow-orchestrator", app)
    _check_min_dapr_runtime_version()
    _assert_execution_read_model_columns()

    # Register all activities from the canonical ACTIVITIES list.
    # To add a new activity, update activities/__init__.py — no changes needed here.
    from activities import ACTIVITIES
    for fn in ACTIVITIES:
        _register_activity(fn)

    logger.info("[Workflow Orchestrator] Registered all activities")

    # Register the only supported workflow interpreter: CNCF Serverless Workflow 1.0.
    wfr.register_versioned_workflow(
        sw_workflow,
        name=SW_WORKFLOW_NAME,
        version_name="1.0.0",
        is_latest=True,
    )
    logger.info(
        "[Workflow Orchestrator] Registered workflows: %s@1.0.0",
        SW_WORKFLOW_NAME,
    )

    # Start the workflow runtime
    wfr.start()
    logger.info("[Workflow Orchestrator] Dapr Workflow Runtime started")

    # Cleanup stale workflow instances without blocking readiness.
    _start_startup_cleanup_thread()

    yield

    # Shutdown
    global _taskhub_channel, _taskhub_stub
    if _taskhub_channel is not None:
        try:
            _taskhub_channel.close()
        except Exception:
            pass
        _taskhub_channel = None
        _taskhub_stub = None
    wfr.shutdown()
    logger.info("[Workflow Orchestrator] Dapr Workflow Runtime stopped")


# Create FastAPI app
app = FastAPI(
    title="Workflow Orchestrator",
    description="Dapr Workflow orchestrator for dynamic workflow execution with child workflow support",
    version="1.0.0",
    lifespan=lifespan,
)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


# --- Request / Response Models ---

class StartWorkflowResponse(BaseModel):
    """Response from starting a workflow."""
    instanceId: str
    workflowId: str
    status: str = "started"
    workflowVersion: str | None = None


class RaiseEventRequest(BaseModel):
    """Request to raise an event."""
    eventName: str
    eventData: Any = None


class TerminateRequest(BaseModel):
    """Request to terminate a workflow."""
    reason: str | None = None


class CloudEvent(BaseModel):
    """CloudEvent schema for pub/sub messages."""
    type: str
    source: str
    specversion: str = "1.0"
    data: dict[str, Any] = Field(default_factory=dict)
    id: str | None = None
    time: str | None = None
    datacontenttype: str = "application/json"


class WorkflowStatusResponse(BaseModel):
    """Workflow status response."""
    instanceId: str
    workflowId: str
    workflowName: str | None = None
    workflowVersion: str | None = None
    workflowNameVersioned: str | None = None
    runtimeStatus: str
    traceId: str | None = None
    phase: str | None = None
    progress: int = 0
    message: str | None = None
    currentNodeId: str | None = None
    currentNodeName: str | None = None
    approvalEventName: str | None = None
    outputs: dict[str, Any] | None = None
    error: str | None = None
    stackTrace: str | None = None
    parentInstanceId: str | None = None
    startedAt: str | None = None
    completedAt: str | None = None


class WorkflowListItemResponse(BaseModel):
    """Workflow list item response."""
    instanceId: str
    workflowId: str
    workflowName: str | None = None
    workflowVersion: str | None = None
    workflowNameVersioned: str | None = None
    runtimeStatus: str
    traceId: str | None = None
    phase: str | None = None
    progress: int = 0
    message: str | None = None
    currentNodeId: str | None = None
    currentNodeName: str | None = None
    error: str | None = None
    startedAt: str | None = None
    completedAt: str | None = None


class WorkflowListResponse(BaseModel):
    """Workflow list response."""
    workflows: list[WorkflowListItemResponse]
    total: int
    limit: int
    offset: int


class WorkflowHistoryEventResponse(BaseModel):
    """Workflow history event response."""
    eventId: int | None = None
    eventType: str
    timestamp: str | None = None
    name: str | None = None
    input: Any = None
    output: Any = None
    metadata: dict[str, Any] | None = None
    raw: dict[str, Any] | None = None


class WorkflowHistoryResponse(BaseModel):
    """Workflow history response."""
    instanceId: str
    events: list[WorkflowHistoryEventResponse]


class RerunWorkflowRequest(BaseModel):
    """Request to rerun a workflow from a specific history event."""
    fromEventId: int = Field(
        default=0,
        description="History event ID to rerun from. 0 means from start.",
    )
    reason: str | None = None


class RuntimeRegistrationResponse(BaseModel):
    """Runtime introspection response for debug UIs."""
    service: str
    version: str
    runtime: str
    ready: bool
    runtimeStatus: dict[str, Any]
    features: list[str]
    registeredWorkflows: list[dict[str, Any]]
    registeredActivities: list[dict[str, Any]]
    errors: list[str] = Field(default_factory=list)
    additional: dict[str, Any] = Field(default_factory=dict)


# --- Helper Functions ---

def get_workflow_client() -> DaprWorkflowClient:
    """Get a Dapr workflow client."""
    return DaprWorkflowClient()


# Activity registry — populated by _register_activity() during startup.
_activity_registry: list[Any] = []
_activity_registry_seen: set[str] = set()


def _register_activity(fn: Any) -> None:
    """Register an activity with both Dapr and the introspection registry."""
    wfr.register_activity(fn)
    if fn.__name__ not in _activity_registry_seen:
        _activity_registry_seen.add(fn.__name__)
        _activity_registry.append(fn)


def _registered_activity_functions() -> list[Any]:
    """Return the list of registered activity function objects."""
    return _activity_registry


def _registered_activity_names() -> list[str]:
    return [fn.__name__ for fn in _activity_registry]


def _get_activity_source(fn: Any) -> str | None:
    """Return the source code of an activity function, or None on failure."""
    try:
        return inspect.getsource(fn)
    except (OSError, TypeError):
        return None


def _get_activity_doc(fn: Any) -> str | None:
    """Return the formatted docstring of an activity function."""
    return inspect.getdoc(fn)


def _annotation_text(annotation: object) -> str:
    if annotation is inspect._empty:
        return "Any"
    if getattr(annotation, "__module__", "") == "typing":
        return str(annotation).replace("typing.", "")
    if isinstance(annotation, type):
        return annotation.__name__
    return getattr(annotation, "__name__", None) or str(annotation)


def _activity_signature(fn: Callable[..., Any]) -> dict[str, Any]:
    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):
        return {"parameters": [], "returnType": None}

    parameters = []
    for param in signature.parameters.values():
        parameters.append({
            "name": param.name,
            "kind": str(param.kind),
            "annotation": _annotation_text(param.annotation),
            "hasDefault": param.default is not inspect._empty,
            "default": None if param.default is inspect._empty else repr(param.default),
        })

    return {
        "parameters": parameters,
        "returnType": _annotation_text(signature.return_annotation),
    }


def _activity_sw_compatibility(fn: Callable[..., Any]) -> dict[str, Any]:
    metadata = get_activity_metadata(fn)
    signature = _activity_signature(fn)
    param_count = len(signature["parameters"])
    reasons: list[str] = []
    action_name = metadata.sw_name if metadata and metadata.sw_name else fn.__name__
    call_target = f"workflow-orchestrator/{action_name}"

    if metadata and metadata.public_callable:
        status = "compatible"
        projection = {
            "functionRefName": action_name,
            "call": call_target,
            "inputShape": "object",
        }
    elif param_count == 2:
        status = "inspect-only"
        reasons.append("activity is discoverable but not explicitly marked public-callable")
        projection = {
            "functionRefName": action_name,
            "call": call_target,
            "inputShape": "object",
        }
    else:
        status = "incompatible"
        reasons.append("activity signature does not match the expected Dapr activity shape")
        projection = None

    return {
        "status": status,
        "reasons": reasons,
        "projection": projection,
    }


def _orchestrator_service_url() -> str:
    return (
        os.environ.get("WORKFLOW_ORCHESTRATOR_URL")
        or os.environ.get("ORCHESTRATOR_URL")
        or f"http://workflow-orchestrator.workflow-builder.svc.cluster.local:{config.PORT}"
    )


def _activity_io_schema(
    fn: Callable[..., Any],
    metadata: Any | None,
    *,
    kind: str,
) -> dict[str, Any]:
    schema = None
    if metadata is not None:
        if kind == "input":
            schema = getattr(metadata, "input_schema", None)
        else:
            schema = getattr(metadata, "output_schema", None)
    if isinstance(schema, dict) and schema:
        return schema
    description = inspect.getdoc(fn) or None
    return {
        "type": "object",
        "description": description,
        "properties": {},
        "additionalProperties": True,
    }


def _activity_execution_definition(fn: Callable[..., Any]) -> dict[str, Any]:
    metadata = get_activity_metadata(fn)
    action_name = metadata.sw_name if metadata and metadata.sw_name else fn.__name__
    task_call = f"workflow-orchestrator/{action_name}"
    endpoint_uri = f"{_orchestrator_service_url()}/api/metadata/actions/{action_name}/invoke"
    input_schema = _activity_io_schema(fn, metadata, kind="input")
    output_schema = _activity_io_schema(fn, metadata, kind="output")
    description = (
        metadata.description
        if metadata and metadata.description
        else (inspect.getdoc(fn) or "")
    )

    task_config = {
        "call": task_call,
        "with": {
            "body": {
                "input": {},
                "metadata": {
                    "service": "workflow-orchestrator",
                    "actionId": fn.__name__,
                    "actionName": action_name,
                    "displayName": metadata.display_name if metadata and metadata.display_name else fn.__name__,
                    "visibility": metadata.visibility if metadata else "inspect-only",
                },
            },
        },
        "input": {
            "schema": {
                "format": "json",
                "document": input_schema,
            },
        },
        "output": {
            "schema": {
                "format": "json",
                "document": output_schema,
            },
        },
    }

    sw_definition = {
        "call": task_call,
        "with": task_config["with"],
    }

    return {
        "definition": sw_definition,
        "taskConfig": task_config,
        "inputSchema": input_schema,
        "outputSchema": output_schema,
        "endpointUri": endpoint_uri,
        "description": description,
        "functionRefName": action_name,
        "displayName": metadata.display_name if metadata and metadata.display_name else fn.__name__,
        "visibility": metadata.visibility if metadata else "inspect-only",
        "insertable": bool(metadata and metadata.public_callable),
    }


def _activity_metadata_payload(fn: Callable[..., Any]) -> dict[str, Any]:
    metadata = get_activity_metadata(fn)
    signature = _activity_signature(fn)
    sw_compatibility = _activity_sw_compatibility(fn)
    execution = _activity_execution_definition(fn) if metadata and metadata.public_callable else None
    input_schema = execution["inputSchema"] if execution else _activity_io_schema(fn, metadata, kind="input")
    output_schema = execution["outputSchema"] if execution else _activity_io_schema(fn, metadata, kind="output")

    sw_payload = {
        "functionName": execution["functionRefName"] if execution else (metadata.sw_name if metadata and metadata.sw_name else fn.__name__),
        "definition": execution["definition"] if execution else None,
        "taskConfig": execution["taskConfig"] if execution else None,
        "warnings": sw_compatibility["reasons"],
    }

    if execution and sw_compatibility.get("projection"):
        sw_compatibility["projection"] = {
            **sw_compatibility["projection"],
            "endpointUri": execution["endpointUri"],
            "inputSchema": input_schema,
        }

    if metadata and metadata.public_callable and not execution:
        sw_compatibility["reasons"].append("public-callable activity is missing executable projection metadata")

    if metadata and metadata.public_callable and not metadata.input_schema:
        sw_compatibility["reasons"].append("public-callable activity uses a generic input schema")

    return {
        "id": fn.__name__,
        "name": execution["functionRefName"] if execution else (metadata.sw_name if metadata and metadata.sw_name else fn.__name__),
        "displayName": execution["displayName"] if execution else (metadata.display_name if metadata and metadata.display_name else fn.__name__),
        "description": execution["description"] if execution else (metadata.description if metadata and metadata.description else (inspect.getdoc(fn) or "")),
        "visibility": metadata.visibility if metadata else "inspect-only",
        "kind": "dapr-activity",
        "service": "workflow-orchestrator",
        "runtime": "python-dapr-workflow",
        "registered": True,
        "ready": True,
        "source": {
            "module": fn.__module__,
            "sourceCode": _get_activity_source(fn),
        },
        "signature": signature,
        "doc": _get_activity_doc(fn),
        "tags": list(metadata.tags) if metadata else [],
        "category": metadata.category if metadata else None,
        "sourceKind": "activity",
        "insertable": bool(metadata and metadata.public_callable),
        "swCompatibility": sw_compatibility,
        "inputSchema": input_schema,
        "outputSchema": output_schema,
        "definition": sw_payload["definition"],
        "taskConfig": sw_payload["taskConfig"],
        "functionRef": {
            "name": sw_payload["functionName"],
            "version": "1.0.0",
        } if metadata and metadata.public_callable else None,
        "sw": sw_payload,
    }


def _registered_workflow_descriptors() -> list[dict[str, Any]]:
    return [
        {
            "name": SW_WORKFLOW_NAME,
            "version": "1.0.0",
            "aliases": [],
            "isLatest": True,
            "source": "service-introspection",
        }
    ]


# --- Database helpers for SW workflow execution ---

_database_url: str | None = None


def _get_database_url() -> str:
    """Fetch DATABASE_URL from the Dapr kubernetes-secrets store (cached)."""
    global _database_url
    if _database_url is not None:
        return _database_url

    import requests as req
    dapr_host = config.DAPR_HOST
    dapr_port = config.DAPR_HTTP_PORT
    url = f"http://{dapr_host}:{dapr_port}/v1.0/secrets/kubernetes-secrets/workflow-builder-secrets"

    try:
        response = req.get(url, timeout=10)
        response.raise_for_status()
        secrets = response.json()
        db_url = secrets.get("DATABASE_URL")
        if not db_url:
            raise RuntimeError("DATABASE_URL not found in Dapr secrets")
        _database_url = db_url
        logger.info("[Execute-By-Id] Fetched DATABASE_URL from Dapr secrets")
        return db_url
    except Exception as e:
        raise RuntimeError(f"Failed to fetch DATABASE_URL: {e}")


def _assert_execution_read_model_columns() -> None:
    """Fail startup unless the execution read-model cutover migration is applied."""
    import psycopg2

    required_columns = {
        "current_node_id",
        "current_node_name",
        "primary_trace_id",
        "workflow_session_id",
        "summary_output",
        "last_agent_event_id",
    }

    db_url = _get_database_url()
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'workflow_executions'
                  AND column_name = ANY(%s)
                """,
                (list(required_columns),),
            )
            existing = {row[0] for row in cur.fetchall()}
    finally:
        conn.close()

    missing = sorted(required_columns - existing)
    if missing:
        raise RuntimeError(
            "Execution read-model schema cutover is incomplete. "
            "Missing workflow_executions columns: "
            f"{', '.join(missing)}. Apply atlas/migrations/20260408120000_add_execution_read_model_columns.sql "
            "or drizzle/0024_execution_read_model.sql before starting workflow-orchestrator."
        )


def _fetch_workflow_from_db(workflow_id: str) -> dict[str, Any]:
    """Fetch a workflow definition from the database by ID."""
    import psycopg2

    db_url = _get_database_url()
    conn = psycopg2.connect(db_url)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, name, description, user_id, nodes, edges, spec, spec_version, dapr_workflow_name
            FROM workflows
            WHERE id = %s
            """,
            (workflow_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

        (
            wf_id,
            wf_name,
            wf_description,
            user_id,
            nodes_json,
            edges_json,
            spec_json,
            spec_version,
            dapr_workflow_name,
        ) = row
        # JSONB columns may already be dicts/lists, or may need parsing
        nodes = json.loads(nodes_json) if isinstance(nodes_json, str) else nodes_json
        edges = json.loads(edges_json) if isinstance(edges_json, str) else edges_json
        spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json

        return {
            "id": wf_id,
            "name": wf_name,
            "description": wf_description,
            "userId": user_id,
            "nodes": nodes,
            "edges": edges,
            "spec": spec,
            "specVersion": spec_version,
            "daprWorkflowName": dapr_workflow_name,
        }
    finally:
        conn.close()


def _generate_execution_id() -> str:
    """Generate a 21-char lowercase/digit execution ID (matches app conventions)."""
    import secrets
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    return "".join(secrets.choice(alphabet) for _ in range(21))


def _create_workflow_execution(
    workflow_id: str,
    user_id: str,
    trigger_data: dict[str, Any],
) -> str:
    """Create a running workflow_executions row and return its ID."""
    import psycopg2

    execution_id = _generate_execution_id()
    db_url = _get_database_url()
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO workflow_executions (
                    id, workflow_id, user_id, status, input, phase, progress, workflow_session_id
                )
                VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s, %s)
                """,
                (
                    execution_id,
                    workflow_id,
                    user_id,
                    "running",
                    json.dumps(trigger_data or {}),
                    "running",
                    0,
                    execution_id,
                ),
            )
        conn.commit()
    finally:
        conn.close()
    return execution_id


def _mark_workflow_execution_started(
    execution_id: str,
    dapr_instance_id: str,
) -> None:
    """Attach dapr instance correlation to an execution row."""
    import psycopg2

    db_url = _get_database_url()
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE workflow_executions
                SET dapr_instance_id = %s, phase = %s, progress = %s, workflow_session_id = COALESCE(workflow_session_id, %s)
                WHERE id = %s
                """,
                (dapr_instance_id, "running", 0, execution_id, execution_id),
            )
        conn.commit()
    finally:
        conn.close()


def _mark_workflow_execution_failed_to_start(execution_id: str, error: str) -> None:
    """Set failure state when workflow scheduling fails before execution starts."""
    import psycopg2
    from datetime import datetime, timezone

    db_url = _get_database_url()
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE workflow_executions
                SET status = %s,
                    phase = %s,
                    progress = %s,
                    error = %s,
                    completed_at = %s
                WHERE id = %s
                """,
                (
                    "error",
                    "failed",
                    100,
                    error,
                    datetime.now(timezone.utc),
                    execution_id,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def _cleanup_stale_instances_on_startup() -> None:
    """Terminate stale Dapr workflow instances and mark DB records on startup.

    Prevents the cascade problem where the orchestrator restart replays all
    running workflow actors from Redis, each creating new sandbox pods.
    """
    stale_threshold_minutes = int(os.environ.get("STALE_THRESHOLD_MINUTES", "60"))
    terminate_timeout_seconds = max(
        1,
        int(os.environ.get("STARTUP_CLEANUP_TERMINATE_TIMEOUT_SECONDS", "15")),
    )
    if os.environ.get("CLEANUP_STALE_ON_STARTUP", "true").lower() != "true":
        logger.info("[Startup Cleanup] Disabled via CLEANUP_STALE_ON_STARTUP=false")
        return

    logger.info(
        "[Startup Cleanup] Cleaning up stale instances older than %d minutes",
        stale_threshold_minutes,
    )

    try:
        import psycopg2

        db_url = _get_database_url()
        conn = psycopg2.connect(db_url)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, dapr_instance_id
                    FROM workflow_executions
                    WHERE status = 'running'
                      AND started_at < NOW() - INTERVAL '%s minutes'
                    """,
                    (stale_threshold_minutes,),
                )
                stale_rows = cur.fetchall()
        finally:
            conn.close()

        if not stale_rows:
            logger.info("[Startup Cleanup] No stale instances found")
            return

        logger.info("[Startup Cleanup] Found %d stale execution(s)", len(stale_rows))
        client = get_workflow_client()
        terminated_count = 0

        for execution_id, dapr_instance_id in stale_rows:
            if dapr_instance_id:
                try:
                    _terminate_workflow_with_timeout(
                        client,
                        dapr_instance_id,
                        terminate_timeout_seconds,
                    )
                    terminated_count += 1
                    logger.info(
                        "[Startup Cleanup] Terminated Dapr instance %s (exec %s)",
                        dapr_instance_id,
                        execution_id,
                    )
                except TimeoutError:
                    logger.warning(
                        "[Startup Cleanup] Timed out terminating %s after %ss",
                        dapr_instance_id,
                        terminate_timeout_seconds,
                    )
                except Exception as term_err:
                    logger.warning(
                        "[Startup Cleanup] Failed to terminate %s: %s",
                        dapr_instance_id,
                        term_err,
                    )

            # Mark DB record as error
            try:
                _mark_workflow_execution_failed_to_start(
                    execution_id,
                    "Terminated on startup: stale instance",
                )
            except Exception as db_err:
                logger.warning(
                    "[Startup Cleanup] Failed to mark execution %s: %s",
                    execution_id,
                    db_err,
                )

        logger.info(
            "[Startup Cleanup] Done: terminated %d Dapr instance(s), "
            "cleaned %d DB record(s)",
            terminated_count,
            len(stale_rows),
        )

    except Exception as exc:
        logger.error("[Startup Cleanup] Failed: %s", exc, exc_info=True)


def _terminate_workflow_with_timeout(
    client: DaprWorkflowClient,
    instance_id: str,
    timeout_seconds: int,
) -> None:
    result: dict[str, BaseException | None] = {"error": None}

    def _terminate() -> None:
        try:
            client.terminate_workflow(instance_id=instance_id)
        except BaseException as exc:  # pragma: no cover - surfaced after join
            result["error"] = exc

    thread = threading.Thread(
        target=_terminate,
        name=f"startup-cleanup-terminate-{instance_id}",
        daemon=True,
    )
    thread.start()
    thread.join(timeout_seconds)

    if thread.is_alive():
        raise TimeoutError(
            f"Timed out terminating workflow instance {instance_id} after "
            f"{timeout_seconds}s"
        )

    if result["error"] is not None:
        raise result["error"]


def _start_startup_cleanup_thread() -> None:
    thread = threading.Thread(
        target=_cleanup_stale_instances_on_startup,
        name="startup-cleanup",
        daemon=True,
    )
    thread.start()
    logger.info("[Startup Cleanup] Background cleanup thread started")


def _topological_sort(nodes: list[dict], edges: list[dict]) -> list[str]:
    """Kahn's algorithm – returns node IDs in execution order (skips trigger/add/note)."""
    edges_by_source: dict[str, list[str]] = {}
    in_degree: dict[str, int] = {}

    for node in nodes:
        nid = node["id"]
        in_degree[nid] = 0
        edges_by_source[nid] = []

    for edge in edges:
        src, tgt = edge["source"], edge["target"]
        edges_by_source.setdefault(src, []).append(tgt)
        in_degree[tgt] = in_degree.get(tgt, 0) + 1

    from collections import deque
    queue = deque(nid for nid, deg in in_degree.items() if deg == 0)
    result: list[str] = []

    while queue:
        nid = queue.popleft()
        node = next((n for n in nodes if n["id"] == nid), None)
        if node:
            ntype = node.get("type", "")
            if ntype not in ("trigger", "add", "note"):
                result.append(nid)
        for neighbor in edges_by_source.get(nid, []):
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)

    return result


def _serialize_node(node: dict) -> dict[str, Any]:
    """Flatten React Flow node format to orchestrator SerializedNode format."""
    data = node.get("data", {})
    return {
        "id": node["id"],
        "type": data.get("type", node.get("type", "action")),
        "label": data.get("label", ""),
        "description": data.get("description"),
        "enabled": data.get("enabled", True),
        "position": node.get("position", {"x": 0, "y": 0}),
        "config": data.get("config", {}),
    }


def _node_type(node: dict[str, Any]) -> str:
    data = node.get("data", {}) if isinstance(node.get("data"), dict) else {}
    return str(data.get("type") or node.get("type") or "")


def _is_while_node(node: dict[str, Any]) -> bool:
    return _node_type(node) == "while"


def _is_while_body_candidate(node: dict[str, Any]) -> bool:
    if _node_type(node) != "action":
        return False
    data = node.get("data", {}) if isinstance(node.get("data"), dict) else {}
    config = data.get("config", {}) if isinstance(data.get("config"), dict) else {}
    return str(config.get("actionType") or "").strip() in {
        "openshell/run",
        "openshell-langgraph/run",
        "openshell-langgraph-observable/run",
    }


def _abs_position(
    node: dict[str, Any],
    by_id: dict[str, dict[str, Any]],
) -> dict[str, float]:
    x = float((node.get("position") or {}).get("x", 0))
    y = float((node.get("position") or {}).get("y", 0))
    current = node
    while current.get("parentId"):
        parent = by_id.get(str(current.get("parentId")))
        if not parent:
            break
        x += float((parent.get("position") or {}).get("x", 0))
        y += float((parent.get("position") or {}).get("y", 0))
        current = parent
    return {"x": x, "y": y}


def _next_unique_id(base: str, used: set[str]) -> str:
    if base not in used:
        return base
    i = 1
    while f"{base}-{i}" in used:
        i += 1
    return f"{base}-{i}"


def _lower_while_nodes(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    while_nodes = [n for n in nodes if _is_while_node(n)]
    if not while_nodes:
        return nodes, edges

    lowered_nodes = list(nodes)
    lowered_edges = list(edges)

    for while_node in while_nodes:
        while_id = str(while_node.get("id") or "")
        if not while_id:
            continue

        by_id = {
            str(node.get("id")): node
            for node in lowered_nodes
            if node.get("id") is not None
        }
        while_abs = _abs_position(while_node, by_id)
        data = while_node.get("data", {}) if isinstance(while_node.get("data"), dict) else {}
        config = data.get("config", {}) if isinstance(data.get("config"), dict) else {}
        while_expression = str(config.get("expression") or "").strip()

        max_iterations_raw = config.get("maxIterations", 20)
        delay_seconds_raw = config.get("delaySeconds", 0)
        try:
            max_iterations = max(1, int(max_iterations_raw))
        except Exception:
            max_iterations = 20
        try:
            delay_seconds = max(0, int(delay_seconds_raw))
        except Exception:
            delay_seconds = 0
        on_max_iterations = str(config.get("onMaxIterations") or "continue").strip().lower()
        if on_max_iterations not in ("continue", "fail"):
            on_max_iterations = "continue"

        children = sorted(
            [
                n
                for n in lowered_nodes
                if str(n.get("parentId") or "") == while_id
            ],
            key=lambda n: str(n.get("id") or ""),
        )
        child_ids = {str(n.get("id") or "") for n in children if n.get("id")}
        body = next((n for n in children if _is_while_body_candidate(n)), None)

        if body is None:
            lowered_nodes = [
                n
                for n in lowered_nodes
                if str(n.get("id") or "") not in child_ids or str(n.get("id") or "") == while_id
            ]
            lowered_edges = [
                e
                for e in lowered_edges
                if str(e.get("source") or "") not in child_ids
                and str(e.get("target") or "") not in child_ids
            ]

            for idx, node in enumerate(lowered_nodes):
                if str(node.get("id") or "") != while_id:
                    continue
                node_data = node.get("data", {}) if isinstance(node.get("data"), dict) else {}
                node_data["type"] = "loop-until"
                node_data["config"] = {
                    "loopStartNodeId": "",
                    "maxIterations": max_iterations,
                    "delaySeconds": delay_seconds,
                    "onMaxIterations": on_max_iterations,
                    "operator": "BOOLEAN_IS_TRUE",
                    "left": True,
                    "conditionMode": "celExpression",
                    "celExpression": f"!({while_expression})" if while_expression else "true",
                    "whileExpression": while_expression,
                }
                node["type"] = "loop-until"
                node["data"] = node_data
                lowered_nodes[idx] = node
                break
            continue

        body_id = str(body.get("id") or "")
        if not body_id:
            continue

        body_abs = _abs_position(body, by_id)
        loop_id = while_id

        incoming = [e for e in lowered_edges if str(e.get("target") or "") == while_id]
        outgoing = [e for e in lowered_edges if str(e.get("source") or "") == while_id]

        next_nodes: list[dict[str, Any]] = []
        for node in lowered_nodes:
            nid = str(node.get("id") or "")
            if nid == while_id:
                continue
            if nid in child_ids and nid != body_id:
                continue
            if nid == body_id:
                node = dict(node)
                node["position"] = body_abs
                node.pop("parentId", None)
                node.pop("extent", None)
            next_nodes.append(node)

        loop_node = {
            "id": loop_id,
            "type": "loop-until",
            "position": {
                "x": max(while_abs["x"] + 250, body_abs["x"] + 240),
                "y": body_abs["y"],
            },
            "data": {
                "label": str(data.get("label") or "While"),
                "description": str(data.get("description") or "Loop while condition is true"),
                "type": "loop-until",
                "config": {
                    "loopStartNodeId": body_id,
                    "maxIterations": max_iterations,
                    "delaySeconds": delay_seconds,
                    "onMaxIterations": on_max_iterations,
                    "operator": "BOOLEAN_IS_TRUE",
                    "left": True,
                    "conditionMode": "celExpression",
                    "celExpression": f"!({while_expression})" if while_expression else "true",
                    "whileExpression": while_expression,
                },
                "status": str(data.get("status") or "idle"),
                "enabled": bool(data.get("enabled", True)),
            },
        }
        next_nodes.append(loop_node)
        lowered_nodes = next_nodes

        lowered_edges = [
            e
            for e in lowered_edges
            if str(e.get("source") or "") != while_id
            and str(e.get("target") or "") != while_id
            and str(e.get("source") or "") not in child_ids
            and str(e.get("target") or "") not in child_ids
        ]

        used_edge_ids = {str(e.get("id") or "") for e in lowered_edges}

        def append_edge(source: str, target: str, source_handle: Any = None, target_handle: Any = None) -> None:
            base = f"{source}->{target}"
            if source_handle:
                base = f"{base}:{source_handle}"
            edge_id = _next_unique_id(base, used_edge_ids)
            used_edge_ids.add(edge_id)
            lowered_edges.append(
                {
                    "id": edge_id,
                    "source": source,
                    "target": target,
                    "sourceHandle": source_handle,
                    "targetHandle": target_handle,
                    "type": "animated",
                }
            )

        for edge in incoming:
            source = str(edge.get("source") or "")
            if source:
                append_edge(
                    source=source,
                    target=body_id,
                    source_handle=edge.get("sourceHandle"),
                    target_handle=edge.get("targetHandle"),
                )

        append_edge(source=body_id, target=loop_id)

        for edge in outgoing:
            target = str(edge.get("target") or "")
            if target:
                append_edge(
                    source=loop_id,
                    target=target,
                    source_handle=edge.get("sourceHandle"),
                    target_handle=edge.get("targetHandle"),
                )

    return lowered_nodes, lowered_edges


def map_runtime_status(dapr_status: str) -> str:
    """Map Dapr runtime status to our status format."""
    status_map = {
        "WORKFLOW_RUNTIME_STATUS_UNSPECIFIED": "UNKNOWN",
        "WORKFLOW_RUNTIME_STATUS_RUNNING": "RUNNING",
        "WORKFLOW_RUNTIME_STATUS_COMPLETED": "COMPLETED",
        "WORKFLOW_RUNTIME_STATUS_FAILED": "FAILED",
        "WORKFLOW_RUNTIME_STATUS_CANCELED": "CANCELED",
        "WORKFLOW_RUNTIME_STATUS_TERMINATED": "TERMINATED",
        "WORKFLOW_RUNTIME_STATUS_PENDING": "PENDING",
        "WORKFLOW_RUNTIME_STATUS_SUSPENDED": "SUSPENDED",
        "WORKFLOW_RUNTIME_STATUS_STALLED": "STALLED",
        # DurableTask orchestration status names (gRPC management APIs)
        "ORCHESTRATION_STATUS_RUNNING": "RUNNING",
        "ORCHESTRATION_STATUS_COMPLETED": "COMPLETED",
        "ORCHESTRATION_STATUS_FAILED": "FAILED",
        "ORCHESTRATION_STATUS_CANCELED": "CANCELED",
        "ORCHESTRATION_STATUS_TERMINATED": "TERMINATED",
        "ORCHESTRATION_STATUS_PENDING": "PENDING",
        "ORCHESTRATION_STATUS_SUSPENDED": "SUSPENDED",
        "ORCHESTRATION_STATUS_STALLED": "STALLED",
        # Handle string values
        "RUNNING": "RUNNING",
        "COMPLETED": "COMPLETED",
        "FAILED": "FAILED",
        "CANCELED": "CANCELED",
        "TERMINATED": "TERMINATED",
        "PENDING": "PENDING",
        "SUSPENDED": "SUSPENDED",
        "STALLED": "STALLED",
    }
    return status_map.get(str(dapr_status), "UNKNOWN")


def _workflow_id_from_instance(instance_id: str) -> str:
    """Extract workflow ID from instance ID.

    Supports formats:
    - Deterministic: ``{workflow_id}-exec-{execution_id}``
    - Legacy random:  ``{workflow_id}-{timestamp_ms}-{random_suffix}``
    - Child:          ``{parent_instance_id}__sub__{node_id}__{index}``
    """
    # Child workflow: strip the __sub__ suffix first
    if "__sub__" in instance_id:
        instance_id = instance_id.split("__sub__")[0]
    # Deterministic format: {workflow_id}-exec-{execution_id}
    if "-exec-" in instance_id:
        return instance_id.split("-exec-")[0]
    # Legacy format: {workflow_id}-{timestamp_ms}-{random_suffix}
    parts = instance_id.rsplit("-", 2)
    if len(parts) == 3 and parts[1].isdigit():
        return parts[0]
    return instance_id.split("-")[0]


def _parse_json_value(value: Any) -> Any:
    """Parse serialized JSON payloads from Dapr workflow state."""
    parsed = value
    while isinstance(parsed, str):
        text = parsed.strip()
        if not text:
            return parsed
        try:
            parsed = json.loads(text)
        except Exception:
            return parsed
    return parsed


def _parse_wrapped_string(wrapper: Any) -> str | None:
    if wrapper is None:
        return None
    value = getattr(wrapper, "value", None)
    if isinstance(value, str) and value:
        return value
    return None


def _timestamp_to_iso(timestamp_field: Any) -> str | None:
    if timestamp_field is None:
        return None
    try:
        seconds = int(getattr(timestamp_field, "seconds", 0) or 0)
        nanos = int(getattr(timestamp_field, "nanos", 0) or 0)
        if seconds == 0 and nanos == 0:
            return None
        return timestamp_field.ToDatetime().isoformat()
    except Exception:
        return None


def _orchestration_state_status_name(orchestration_state: Any) -> str:
    """
    Return best-effort orchestration status enum name.

    Dapr workflow wrappers expose this via WorkflowState.runtime_status, while
    TaskHub gRPC APIs expose it via orchestrationStatus.
    """
    status_attr = getattr(orchestration_state, "orchestrationStatus", None)
    if status_attr is None:
        runtime_status = getattr(orchestration_state, "runtime_status", None)
        if runtime_status is not None:
            return (
                runtime_status.name
                if hasattr(runtime_status, "name")
                else str(runtime_status)
            )
        return "UNKNOWN"
    try:
        return pb.OrchestrationStatus.Name(status_attr)
    except Exception:
        return str(status_attr)


def _build_workflow_status_payload(instance_id: str, orchestration_state: Any) -> dict[str, Any]:
    """Build normalized workflow status payload from TaskHub orchestration state."""
    runtime_status = map_runtime_status(
        _orchestration_state_status_name(orchestration_state)
    )
    custom_status_raw = _parse_wrapped_string(
        getattr(orchestration_state, "customStatus", None)
    )
    custom_status = _parse_json_value(custom_status_raw)
    phase = None
    progress = 0
    message = None
    current_node_id = None
    current_node_name = None
    approval_event_name = None
    trace_id = None
    workflow_version = _parse_wrapped_string(
        getattr(orchestration_state, "version", None)
    )
    outputs = None
    error = None
    stack_trace = None
    parent_instance_id = _parse_wrapped_string(
        getattr(orchestration_state, "parentInstanceId", None)
    )

    if isinstance(custom_status, dict):
        phase = custom_status.get("phase")
        progress = custom_status.get("progress", 0)
        message = custom_status.get("message")
        current_node_id = custom_status.get("currentNodeId")
        current_node_name = custom_status.get("currentNodeName")
        approval_event_name = custom_status.get("approvalEventName")
        trace_id = custom_status.get("traceId") or custom_status.get("trace_id")
        workflow_version = (
            str(custom_status.get("workflowVersion") or "").strip()
            or workflow_version
        )

    input_payload = _parse_json_value(
        _parse_wrapped_string(getattr(orchestration_state, "input", None))
    )
    if not trace_id and isinstance(input_payload, dict):
        otel_ctx = input_payload.get("_otel")
        if isinstance(otel_ctx, dict):
            trace_id = (
                str(otel_ctx.get("traceId") or "").strip()
                or _trace_id_from_traceparent(otel_ctx.get("traceparent"))
            )

    serialized_output = _parse_json_value(
        _parse_wrapped_string(getattr(orchestration_state, "output", None))
    )
    if isinstance(serialized_output, dict):
        outputs = serialized_output
        if not trace_id:
            trace_id = str(serialized_output.get("traceId") or "").strip() or None
        nested_outputs = serialized_output.get("outputs")
        if not trace_id and isinstance(nested_outputs, dict):
            for value in nested_outputs.values():
                if not isinstance(value, dict):
                    continue
                candidate = str(
                    value.get("traceId")
                    or (
                        value.get("agentProgress", {}).get("traceId")
                        if isinstance(value.get("agentProgress"), dict)
                        else ""
                    )
                    or ""
                ).strip()
                if candidate:
                    trace_id = candidate
                    break
    elif serialized_output is not None:
        outputs = {"raw": serialized_output}

    failure_details = getattr(orchestration_state, "failureDetails", None)
    if failure_details is not None:
        failure_message = str(getattr(failure_details, "errorMessage", "") or "")
        if isinstance(failure_message, str) and failure_message:
            error = failure_message
        stack_trace = _parse_wrapped_string(getattr(failure_details, "stackTrace", None))

    started_at = _timestamp_to_iso(getattr(orchestration_state, "createdTimestamp", None))

    completed_at = None
    if runtime_status in ("COMPLETED", "FAILED", "TERMINATED"):
        completed_at = _timestamp_to_iso(
            getattr(orchestration_state, "completedTimestamp", None)
        ) or _timestamp_to_iso(getattr(orchestration_state, "lastUpdatedTimestamp", None))

    workflow_name = str(getattr(orchestration_state, "name", "") or "") or None
    workflow_name_versioned = (
        f"{workflow_name}@{workflow_version}"
        if workflow_name and workflow_version
        else workflow_name
    )

    workflow_id = _workflow_id_from_instance(instance_id)

    return {
        "instanceId": instance_id,
        "workflowId": workflow_id,
        "workflowName": workflow_name,
        "workflowVersion": workflow_version,
        "workflowNameVersioned": workflow_name_versioned,
        "runtimeStatus": runtime_status,
        "traceId": trace_id,
        "phase": phase or (runtime_status.lower() if runtime_status in ("RUNNING", "PENDING") else None),
        "progress": progress if isinstance(progress, int) else 0,
        "message": message,
        "currentNodeId": current_node_id,
        "currentNodeName": current_node_name,
        "approvalEventName": approval_event_name,
        "outputs": outputs,
        "error": error,
        "stackTrace": stack_trace,
        "parentInstanceId": parent_instance_id,
        "startedAt": started_at,
        "completedAt": completed_at,
    }


def _query_instances(
    *,
    status_filter: set[str] | None = None,
    fetch_payloads: bool = True,
    continuation_token: str | None = None,
    page_size: int = 200,
) -> tuple[list[Any], str | None]:
    """Query orchestration instances using TaskHub management API."""
    query = pb.InstanceQuery(
        maxInstanceCount=page_size,
        fetchInputsAndOutputs=fetch_payloads,
    )
    if status_filter:
        status_to_enum = {
            "RUNNING": pb.ORCHESTRATION_STATUS_RUNNING,
            "COMPLETED": pb.ORCHESTRATION_STATUS_COMPLETED,
            "FAILED": pb.ORCHESTRATION_STATUS_FAILED,
            "CANCELED": pb.ORCHESTRATION_STATUS_CANCELED,
            "TERMINATED": pb.ORCHESTRATION_STATUS_TERMINATED,
            "PENDING": pb.ORCHESTRATION_STATUS_PENDING,
            "SUSPENDED": pb.ORCHESTRATION_STATUS_SUSPENDED,
            "STALLED": pb.ORCHESTRATION_STATUS_STALLED,
        }
        for status in status_filter:
            enum_value = status_to_enum.get(status.upper())
            if enum_value is not None:
                query.runtimeStatus.append(enum_value)
    if continuation_token:
        query.continuationToken.CopyFrom(
            wrappers_pb2.StringValue(value=continuation_token)
        )
    response = _taskhub_call("QueryInstances", pb.QueryInstancesRequest(query=query))
    next_token = _parse_wrapped_string(getattr(response, "continuationToken", None))
    return list(getattr(response, "orchestrationState", []) or []), next_token


def _normalize_history_event(event: Any) -> dict[str, Any]:
    """Normalize a durabletask HistoryEvent protobuf object."""
    from google.protobuf.json_format import MessageToDict

    payload_name = "unknown"
    payload = None
    for field_descriptor, value in event.ListFields():
        if field_descriptor.name in ("eventId", "timestamp", "router"):
            continue
        payload_name = field_descriptor.name
        payload = value
        break

    payload_dict = (
        MessageToDict(payload, preserving_proto_field_name=True)
        if payload is not None
        else {}
    )

    name_value = None
    for key in ("name", "event_name", "instance_id", "task_execution_id", "task_scheduled_id"):
        value = payload_dict.get(key)
        if isinstance(value, (str, int)):
            name_value = str(value)
            break

    input_value = payload_dict.get("input")
    if isinstance(input_value, dict):
        input_value = input_value.get("value", input_value)
    output_value = payload_dict.get("result")
    if isinstance(output_value, dict):
        output_value = output_value.get("value", output_value)
    if output_value is None and "failure_details" in payload_dict:
        output_value = payload_dict.get("failure_details")

    metadata: dict[str, Any] = {}
    if "orchestration_status" in payload_dict:
        metadata["status"] = map_runtime_status(str(payload_dict["orchestration_status"]))
    task_id = payload_dict.get("task_scheduled_id") or payload_dict.get("task_execution_id")
    if isinstance(task_id, (str, int)):
        metadata["taskId"] = str(task_id)
    failure_details = payload_dict.get("failure_details")
    if isinstance(failure_details, dict):
        error_message = failure_details.get("error_message")
        if isinstance(error_message, str) and error_message:
            metadata["error"] = error_message
        stack_trace = failure_details.get("stack_trace")
        if isinstance(stack_trace, dict):
            stack_trace = stack_trace.get("value")
        if isinstance(stack_trace, str) and stack_trace:
            metadata["stackTrace"] = stack_trace
    rerun_parent = payload_dict.get("rerun_parent_instance_info")
    if isinstance(rerun_parent, dict):
        source_instance_id = rerun_parent.get("instance_id")
        if isinstance(source_instance_id, str) and source_instance_id:
            metadata["rerunSourceInstanceId"] = source_instance_id
    version_value = payload_dict.get("version")
    if isinstance(version_value, dict):
        version_value = version_value.get("value")
    if isinstance(version_value, str) and version_value:
        metadata["version"] = version_value

    timestamp = None
    if hasattr(event, "timestamp") and event.HasField("timestamp"):
        timestamp = event.timestamp.ToDatetime().isoformat()

    event_id = int(event.eventId) if getattr(event, "eventId", 0) > 0 else None
    event_type = payload_name[0:1].upper() + payload_name[1:]

    return {
        "eventId": event_id,
        "eventType": event_type,
        "timestamp": timestamp,
        "name": name_value,
        "input": _parse_json_value(input_value),
        "output": _parse_json_value(output_value),
        "metadata": metadata or None,
        "raw": payload_dict or None,
    }


def _get_instance_history(instance_id: str) -> list[dict[str, Any]]:
    """Get workflow execution history events via Dapr 1.17 APIs."""
    response = _taskhub_call("GetInstanceHistory", pb.GetInstanceHistoryRequest(instanceId=instance_id))
    return [_normalize_history_event(event) for event in response.events]


# --- Routes ---

class ExecuteSWWorkflowRequest(BaseModel):
    """Request body for executing a CNCF Serverless Workflow 1.0 document."""
    workflow: dict = Field(..., description="CNCF SW 1.0 workflow JSON document")
    workflowId: str | None = None
    triggerData: dict = Field(default_factory=dict)
    integrations: dict | None = None
    dbExecutionId: str | None = None


@app.post("/api/v2/sw-workflows", response_model=StartWorkflowResponse)
def execute_sw_workflow(request: ExecuteSWWorkflowRequest, http_request: Request):
    """
    Execute a CNCF Serverless Workflow 1.0 document.

    POST /api/v2/sw-workflows

    Accepts a full SW 1.0 JSON document and executes it via the
    sw_workflow_v1 Dapr workflow interpreter.
    """
    try:
        from core.sw_types import Workflow as SWWorkflowModel

        # Validate the workflow document
        sw_workflow_doc = SWWorkflowModel.model_validate(request.workflow)
        workflow_name = sw_workflow_doc.document.name

        db_execution_id = request.dbExecutionId
        if not db_execution_id:
            workflow_id = str(request.workflowId or "").strip()
            if not workflow_id:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "workflowId is required when dbExecutionId is omitted. "
                        "The workflow orchestrator now requires a persisted "
                        "workflow_executions row for every SW execution."
                    ),
                )

            workflow_record = _fetch_workflow_from_db(workflow_id)
            db_execution_id = _create_workflow_execution(
                workflow_id=workflow_record["id"],
                user_id=workflow_record["userId"],
                trigger_data=request.triggerData,
            )

        otel_ctx = _merge_otel_context(http_request)
        session_id = workflow_session_id(db_execution_id) or extract_session_id(otel_ctx)
        if session_id:
            otel_ctx["sessionId"] = session_id
            otel_ctx["session.id"] = session_id
            otel_ctx["workflow.execution.id"] = session_id
        try:
            from opentelemetry import trace as ot_trace

            attach_workflow_session(ot_trace.get_current_span(), session_id)
        except Exception:
            pass

        workflow_input = {
            "workflow": request.workflow,
            "workflowId": request.workflowId,
            "triggerData": request.triggerData,
            "integrations": request.integrations,
            "dbExecutionId": db_execution_id,
            "_otel": otel_ctx,
        }

        import re
        safe_name = re.sub(r'[^a-z0-9-]', '-', workflow_name.lower()).strip('-')[:40]
        instance_id = f"sw-{safe_name}-exec-{db_execution_id}"

        logger.info(
            "[SW Workflow] Starting: %s (%s)",
            workflow_name,
            instance_id,
        )

        result_id = _idempotent_schedule(
            workflow_name=SW_WORKFLOW_NAME,
            instance_id=instance_id,
            workflow_input=workflow_input,
            workflow_version="1.0.0",
            parent_trace_context=otel_ctx,
        )

        if db_execution_id:
            _mark_workflow_execution_started(db_execution_id, result_id)

        return StartWorkflowResponse(
            instanceId=result_id,
            workflowId=workflow_name,
            status="started",
            workflowVersion="1.0.0",
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[SW Workflow] Failed to execute: {e}")
        _raise_workflow_route_error("execute_sw_workflow", e)


@app.get("/api/workflows/{instance_id}")
def get_workflow_detail(instance_id: str):
    """
    Get workflow detail (delegates to status endpoint).

    GET /api/workflows/:instanceId
    """
    status = get_workflow_status(instance_id)
    data = status.model_dump() if hasattr(status, "model_dump") else status.dict()
    data["status"] = data.get("runtimeStatus", "UNKNOWN")
    return data


@app.get("/api/v2/workflows", response_model=WorkflowListResponse)
def list_workflows(
    status: str | None = None,
    search: str | None = None,
    limit: int = 50,
    offset: int = 0,
):
    """
    List workflow instances.

    GET /api/v2/workflows
    """
    try:
        normalized_limit = max(1, min(limit, 200))
        normalized_offset = max(0, offset)
        status_filter = {
            part.strip().upper()
            for part in (status or "").split(",")
            if part.strip()
        }
        search_filter = (search or "").strip().lower()

        instance_states: list[Any] = []
        continuation_token: str | None = None
        max_scan = 5000

        while len(instance_states) < max_scan:
            page_states, continuation_token = _query_instances(
                status_filter=status_filter if status_filter else None,
                fetch_payloads=True,
                continuation_token=continuation_token,
                page_size=200,
            )
            if not page_states:
                break
            instance_states.extend(page_states)
            if not continuation_token:
                break

        items: list[dict[str, Any]] = []
        for state in instance_states[:max_scan]:
            instance_id = str(getattr(state, "instanceId", "") or "")
            if not instance_id:
                continue
            payload = _build_workflow_status_payload(instance_id, state)
            runtime_status = str(payload.get("runtimeStatus") or "UNKNOWN").upper()
            if status_filter and runtime_status not in status_filter:
                continue

            if search_filter:
                fields = [
                    str(payload.get("instanceId") or ""),
                    str(payload.get("workflowId") or ""),
                    str(payload.get("workflowName") or ""),
                    str(payload.get("phase") or ""),
                    str(payload.get("message") or ""),
                ]
                if not any(search_filter in field.lower() for field in fields):
                    continue

            items.append(payload)

        items.sort(
            key=lambda item: str(item.get("startedAt") or ""),
            reverse=True,
        )
        total = len(items)
        page = items[normalized_offset : normalized_offset + normalized_limit]
        workflows = [WorkflowListItemResponse(**item) for item in page]

        return WorkflowListResponse(
            workflows=workflows,
            total=total,
            limit=normalized_limit,
            offset=normalized_offset,
        )
    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to list workflows: {e}")
        if _is_taskhub_unimplemented_error(e):
            raise HTTPException(
                status_code=501,
                detail={
                    "code": "workflow_query_unsupported",
                    "error": (
                        "This Dapr runtime does not implement workflow instance listing "
                        "via QueryInstances"
                    ),
                    "rawError": str(e),
                },
            )
        _raise_workflow_route_error("list_workflows", e)


@app.get("/api/v2/workflows/{instance_id}/status", response_model=WorkflowStatusResponse)
def get_workflow_status(instance_id: str):
    """
    Get workflow status.

    GET /api/v2/workflows/:instanceId/status
    """
    try:
        response = _taskhub_call(
            "GetInstance",
            pb.GetInstanceRequest(instanceId=instance_id, getInputsAndOutputs=True),
        )
        if not getattr(response, "exists", False):
            raise HTTPException(status_code=404, detail="Workflow not found")
        payload = _build_workflow_status_payload(instance_id, response.orchestrationState)
        return WorkflowStatusResponse(**payload)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to get workflow status: {e}")
        _raise_workflow_route_error("get_workflow_status", e)


@app.get("/api/v2/workflows/{instance_id}/history", response_model=WorkflowHistoryResponse)
def get_workflow_history(instance_id: str):
    """
    Get workflow execution history.

    GET /api/v2/workflows/:instanceId/history
    """
    try:
        response = _taskhub_call(
            "GetInstance",
            pb.GetInstanceRequest(instanceId=instance_id, getInputsAndOutputs=False),
        )
        if not getattr(response, "exists", False):
            raise HTTPException(status_code=404, detail="Workflow not found")

        events = _get_instance_history(instance_id)
        events.sort(key=lambda item: str(item.get("timestamp") or ""), reverse=True)

        return WorkflowHistoryResponse(
            instanceId=instance_id,
            events=[WorkflowHistoryEventResponse(**event) for event in events],
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to get workflow history: {e}")
        _raise_workflow_route_error("get_workflow_history", e)


@app.post("/api/v2/workflows/{instance_id}/rerun")
def rerun_workflow(instance_id: str, request: RerunWorkflowRequest = RerunWorkflowRequest()):
    """
    Rerun a workflow from a specific history event.

    POST /api/v2/workflows/:instanceId/rerun
    """
    try:
        state_response = _taskhub_call(
            "GetInstance",
            pb.GetInstanceRequest(instanceId=instance_id, getInputsAndOutputs=False),
        )
        if not getattr(state_response, "exists", False):
            raise HTTPException(status_code=404, detail="Workflow not found")

        event_id = max(0, int(request.fromEventId))
        rerun_request = pb.RerunWorkflowFromEventRequest(
            sourceInstanceID=instance_id,
            eventID=event_id,
        )
        rerun_response = _taskhub_call("RerunWorkflowFromEvent", rerun_request)
        new_instance_id = str(getattr(rerun_response, "newInstanceID", "") or "")
        if not new_instance_id:
            raise RuntimeError("Rerun succeeded but no newInstanceID was returned")

        logger.info(
            "[Workflow Routes] Rerun scheduled: source=%s event_id=%s new=%s reason=%s",
            instance_id,
            event_id,
            new_instance_id,
            request.reason,
        )

        return {
            "success": True,
            "sourceInstanceId": instance_id,
            "fromEventId": event_id,
            "newInstanceId": new_instance_id,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to rerun workflow: {e}")
        _raise_workflow_route_error("rerun_workflow", e)


@app.post("/api/v2/workflows/{instance_id}/events")
def raise_event(instance_id: str, request: RaiseEventRequest):
    """
    Raise an external event to a workflow.

    POST /api/v2/workflows/:instanceId/events
    """
    try:
        client = get_workflow_client()

        event_data = request.eventData if isinstance(request.eventData, dict) else {}
        workflow_id = (
            event_data.get("workflow_id")
            or event_data.get("workflowId")
            or event_data.get("agentWorkflowId")
        )
        if request.eventName.startswith("agent_completed_") and _is_native_agent_child_workflow_id(workflow_id):
            logger.info(
                "[Workflow Routes] Ignoring bridged completion event for native child workflow: %s",
                workflow_id,
            )
            return {
                "success": True,
                "instanceId": instance_id,
                "eventName": request.eventName,
                "ignored": True,
                "reason": "native-child-workflow",
            }

        logger.info(
            f"[Workflow Routes] Raising event \"{request.eventName}\" for workflow: {instance_id}"
        )

        client.raise_workflow_event(
            instance_id=instance_id,
            event_name=request.eventName,
            data=request.eventData,
        )

        return {
            "success": True,
            "instanceId": instance_id,
            "eventName": request.eventName,
        }

    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to raise event: {e}")
        _raise_workflow_route_error("raise_event", e)


@app.post("/api/v2/workflows/{instance_id}/terminate")
def terminate_workflow(instance_id: str, request: TerminateRequest = TerminateRequest()):
    """
    Terminate a running workflow.

    POST /api/v2/workflows/:instanceId/terminate
    """
    try:
        client = get_workflow_client()

        logger.info(
            f"[Workflow Routes] Terminating workflow: {instance_id}"
            + (f" Reason: {request.reason}" if request.reason else "")
        )

        child_termination = None
        try:
            child_termination = terminate_durable_runs_by_parent_execution(
                parent_execution_id=instance_id,
                reason=request.reason,
                cleanup_workspace=True,
            )
            logger.info(
                "[Workflow Routes] Child durable run termination summary: "
                f"{child_termination}"
            )
        except Exception as child_err:
            logger.warning(
                f"[Workflow Routes] Child durable run termination failed: {child_err}"
            )

        client.terminate_workflow(instance_id=instance_id, output=request.reason)

        return {
            "success": True,
            "instanceId": instance_id,
            "childTermination": child_termination,
        }

    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to terminate workflow: {e}")
        _raise_workflow_route_error("terminate_workflow", e)


@app.delete("/api/v2/workflows/{instance_id}")
def purge_workflow(
    instance_id: str,
    force: bool = False,
    recursive: bool = False,
):
    """
    Purge a completed workflow.

    DELETE /api/v2/workflows/:instanceId
    """
    try:
        logger.info(
            "[Workflow Routes] Purging workflow: %s force=%s recursive=%s",
            instance_id,
            force,
            recursive,
        )

        child_cleanup = None
        if force:
            try:
                child_cleanup = terminate_durable_runs_by_parent_execution(
                    parent_execution_id=instance_id,
                    reason="Force purge cleanup",
                    cleanup_workspace=True,
                )
            except Exception as child_err:
                logger.warning(
                    "[Workflow Routes] Child durable run cleanup failed during force purge: %s",
                    child_err,
                )

        purge_request = pb.PurgeInstancesRequest(
            instanceId=instance_id,
            recursive=recursive,
            force=force,
        )
        purge_response = _taskhub_call("PurgeInstances", purge_request)

        return {
            "success": True,
            "instanceId": instance_id,
            "force": force,
            "recursive": recursive,
            "deletedInstanceCount": int(
                getattr(purge_response, "deletedInstanceCount", 0) or 0
            ),
            "isComplete": bool(
                getattr(getattr(purge_response, "isComplete", None), "value", True)
            ),
            "childCleanup": child_cleanup,
        }

    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to purge workflow: {e}")
        _raise_workflow_route_error("purge_workflow", e)


@app.post("/api/v2/workflows/{instance_id}/pause")
def suspend_workflow(instance_id: str):
    """
    Suspend (pause) a running workflow.

    POST /api/v2/workflows/:instanceId/pause
    """
    try:
        client = get_workflow_client()

        logger.info(f"[Workflow Routes] Suspending workflow: {instance_id}")

        client.suspend_workflow(instance_id=instance_id)

        return {
            "success": True,
            "instanceId": instance_id,
        }

    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to suspend workflow: {e}")
        _raise_workflow_route_error("suspend_workflow", e)


@app.post("/api/v2/workflows/{instance_id}/resume")
def resume_workflow(instance_id: str):
    """
    Resume a paused workflow.

    POST /api/v2/workflows/:instanceId/resume
    """
    try:
        client = get_workflow_client()

        logger.info(f"[Workflow Routes] Resuming workflow: {instance_id}")

        client.resume_workflow(instance_id=instance_id)

        return {
            "success": True,
            "instanceId": instance_id,
        }

    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to resume workflow: {e}")
        _raise_workflow_route_error("resume_workflow", e)


# --- Pub/Sub Subscription Routes ---

@app.post("/subscriptions/agent-events")
def agent_events_subscription(event: CloudEvent):
    """
    Handle agent completion events from pub/sub.

    This endpoint handles legacy or external completion events forwarded over
    Dapr pub/sub. Native OpenShell child workflows complete through
    child-workflow results rather than this callback path.
    """
    logger.info(f"[Subscription] Received agent event: {event.type}")

    # Forward agent completion events to parent workflows
    from dapr.ext.workflow import DaprWorkflowClient

    event_data = event.data
    actual_event_type = event_data.get("type", event.type)

    completion_event_types = {"agent_completed", "execution_completed"}
    if actual_event_type not in completion_event_types:
        return {"status": "SUCCESS", "result": {"status": "ignored", "event_type": actual_event_type}}

    try:
        inner_data = event_data.get("data", {})
        parent_execution_id = inner_data.get("parent_execution_id")

        if not parent_execution_id:
            return {"status": "SUCCESS", "result": {"status": "ignored", "reason": "no_parent_execution_id"}}

        workflow_id = event_data.get("workflowId", "")
        if "__msagent__" in workflow_id or "__dapr__" in workflow_id:
            return {
                "status": "SUCCESS",
                "result": {
                    "status": "ignored",
                    "reason": "native-child-workflow",
                    "workflowId": workflow_id,
                },
            }
        external_event_name = f"agent_completed_{workflow_id}"

        event_payload = {
            "workflow_id": workflow_id,
            "phase": inner_data.get("phase", actual_event_type.replace("_completed", "")),
            "success": inner_data.get("success", True),
            "result": inner_data.get("result", {}),
            "error": inner_data.get("error"),
            "timestamp": event_data.get("timestamp"),
        }

        client = DaprWorkflowClient()
        client.raise_workflow_event(
            instance_id=parent_execution_id,
            event_name=external_event_name,
            data=event_payload,
        )

        return {"status": "SUCCESS", "result": {"status": "forwarded", "event_type": actual_event_type}}
    except Exception as e:
        logger.error(f"[Agent Events] Failed to handle event: {e}")
        return {"status": "SUCCESS", "result": {"status": "error", "error": str(e)}}


@app.options("/subscriptions/agent-events")
def agent_events_subscription_options():
    """CORS preflight handler for Dapr subscription endpoint."""
    return {}


PUBSUB_NAME = config.PUBSUB_NAME

@app.get("/dapr/subscribe")
def subscribe():
    """
    Declare pub/sub subscriptions for Dapr.

    This endpoint tells Dapr which topics this service subscribes to.
    """
    return [
        {
            "pubsubname": PUBSUB_NAME,
            "topic": "workflow.stream",
            "route": "/subscriptions/agent-events",
            "routes": {
                "rules": [
                    {
                        "match": "event.type == \"agent_completed\"",
                        "path": "/subscriptions/agent-events",
                    },
                    {
                        "match": "event.type == \"execution_completed\"",
                        "path": "/subscriptions/agent-events",
                    },
                ],
                "default": "/subscriptions/agent-events",
            },
        }
    ]


# --- Health Routes ---

@app.get("/healthz")
def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "service": "workflow-orchestrator"}


@app.get("/readyz")
def readiness_check():
    """Readiness check endpoint."""
    ready, runtime_status = _get_workflow_runtime_status()
    if not ready:
        raise HTTPException(
            status_code=503,
            detail={
                "status": "not_ready",
                "service": "workflow-orchestrator",
                "code": "workflow_runtime_unavailable",
                "runtimeStatus": runtime_status,
            },
        )
    return {
        "status": "ready",
        "service": "workflow-orchestrator",
        "runtimeStatus": runtime_status,
    }


@app.get("/config")
def get_config():
    """Get orchestrator configuration."""
    return {
        "service": "workflow-orchestrator",
        "version": "1.0.0",
        "runtime": "python-dapr-workflow",
        "features": [
            "dynamic-workflow",
            "ap-workflow",
            "child-workflows",
            "approval-gates",
            "timers",
            "function-router-integration",
        ],
    }


@app.get("/api/v2/runtime/introspect", response_model=RuntimeRegistrationResponse)
def get_runtime_introspection():
    """Expose workflow runtime registrations and readiness for debug tooling."""
    ready, runtime_status = _get_workflow_runtime_status()
    errors = []
    runtime_errors = runtime_status.get("errors")
    if isinstance(runtime_errors, list):
        errors = [str(item) for item in runtime_errors]

    return RuntimeRegistrationResponse(
        service="workflow-orchestrator",
        version="1.0.0",
        runtime="python-dapr-workflow",
        ready=ready,
        runtimeStatus=runtime_status,
        features=[
            "dynamic-workflow",
            "ap-workflow",
            "child-workflows",
            "approval-gates",
            "timers",
            "function-router-integration",
        ],
        registeredWorkflows=_registered_workflow_descriptors(),
        registeredActivities=[
            {
                "name": fn.__name__,
                "source": "service-introspection",
                "sourceCode": _get_activity_source(fn),
                "doc": _get_activity_doc(fn),
            }
            for fn in _registered_activity_functions()
        ],
        errors=errors,
        additional={
            "config": {
                "swWorkflowVersion": "1.0.0",
                "stateStoreName": config.STATE_STORE_NAME,
                "pubsubName": config.PUBSUB_NAME,
                "durableAgentAppId": config.DURABLE_AGENT_APP_ID,
            },
        },
    )


@app.get("/api/metadata/actions")
def get_activity_metadata_index():
    """Return normalized activity metadata for the builder catalog."""
    actions = [_activity_metadata_payload(fn) for fn in _registered_activity_functions()]
    actions.sort(key=lambda item: str(item["displayName"]).lower())
    return {
        "service": "workflow-orchestrator",
        "runtime": "python-dapr-workflow",
        "actions": actions,
        "count": len(actions),
    }


@app.get("/api/metadata/actions/{action_id}")
def get_activity_metadata_detail(action_id: str):
    """Return normalized metadata for one activity."""
    for fn in _registered_activity_functions():
        metadata = get_activity_metadata(fn)
        if fn.__name__ == action_id or (metadata and metadata.sw_name == action_id):
            return {
                "service": "workflow-orchestrator",
                "runtime": "python-dapr-workflow",
                "action": _activity_metadata_payload(fn),
            }
    raise HTTPException(status_code=404, detail=f"Action {action_id} not found")


def _invoke_public_activity(action_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    for fn in _registered_activity_functions():
        metadata = get_activity_metadata(fn)
        if fn.__name__ != action_id and (not metadata or metadata.sw_name != action_id):
            continue

        if not metadata or not metadata.public_callable:
            raise HTTPException(
                status_code=403,
                detail=f"Action {action_id} is inspect-only and cannot be invoked",
            )

        input_data: dict[str, Any]
        if (
            isinstance(payload.get("body"), dict)
            and isinstance(payload["body"].get("input"), dict)
        ):
            input_data = payload["body"]["input"]  # type: ignore[index,assignment]
        elif isinstance(payload.get("input"), dict):
            input_data = payload["input"]  # type: ignore[assignment]
        elif isinstance(payload.get("body"), dict):
            input_data = payload["body"]  # type: ignore[assignment]
        else:
            input_data = {
                key: value
                for key, value in payload.items()
                if key not in {"metadata", "actionId", "actionName", "body", "input"}
            }

        started = time.perf_counter()
        try:
            result = fn(None, input_data)
        except Exception as exc:
            logger.exception("[Workflow Orchestrator] Activity %s failed", action_id)
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        duration_ms = int((time.perf_counter() - started) * 1000)

        return {
            "success": True,
            "action": _activity_metadata_payload(fn),
            "data": jsonable_encoder(result),
            "duration_ms": duration_ms,
        }

    raise HTTPException(status_code=404, detail=f"Action {action_id} not found")


@app.post("/api/metadata/actions/{action_id}/invoke")
async def invoke_activity(action_id: str, request: Request):
    """Invoke a public-callable activity directly for safe testing."""
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")

    return _invoke_public_activity(action_id, payload)


@app.post("/api/metadata/actions/{action_id}/test")
async def test_activity(action_id: str, request: Request):
    """Alias for the safe invoke endpoint used by the builder test UI."""
    return await invoke_activity(action_id, request)


@app.post("/execute")
async def execute_public_activity(request: Request):
    """OpenFunction-style executor for public-callable workflow activities."""
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")

    raw_step = payload.get("step")
    if not isinstance(raw_step, str) or not raw_step.strip():
        raise HTTPException(status_code=400, detail="step is required")

    action_id = raw_step.strip().split("/")[-1]
    input_payload = payload.get("input")
    if not isinstance(input_payload, dict):
        input_payload = {}

    return _invoke_public_activity(action_id, input_payload)


# Entry point for uvicorn
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)
