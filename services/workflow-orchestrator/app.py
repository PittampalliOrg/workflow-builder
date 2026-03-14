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

KEY FEATURE: Native child workflow support for durable agent actions via durable-agent.
"""

from __future__ import annotations

import json
import logging
import os
import random
import string
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import grpc
import requests
import durabletask.internal.orchestrator_service_pb2 as pb
import durabletask.internal.orchestrator_service_pb2_grpc as pb_grpc
from dapr.ext.workflow import DaprWorkflowClient
from fastapi import FastAPI, HTTPException
from google.protobuf import wrappers_pb2
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from core.config import config
from workflows.dynamic_workflow import wfr, dynamic_workflow
from workflows.ap_workflow import ap_workflow
from activities.execute_action import execute_action
from activities.persist_state import persist_state, get_state, delete_state
from activities.publish_event import (
    publish_event,
    publish_phase_changed,
    publish_workflow_started,
    publish_workflow_completed,
    publish_workflow_failed,
    publish_approval_requested,
)
from activities.log_external_event import (
    log_external_event,
    log_approval_request,
    log_approval_response,
    log_approval_timeout,
)
from activities.call_agent_service import (
    call_durable_agent_run,
    call_durable_plan,
    call_durable_execute_plan,
    call_durable_execute_plan_dag,
    terminate_ms_agent_run,
    terminate_durable_agent_run,
    terminate_durable_runs_by_parent_execution,
    cleanup_execution_workspaces,
)
from activities.log_node_execution import log_node_start, log_node_complete
from activities.persist_results_to_db import persist_results_to_db
from activities.send_ap_callback import send_ap_callback, send_ap_step_update
from activities.fetch_child_workflow import fetch_child_workflow
from activities.track_agent_run import (
    track_agent_run_scheduled,
    track_agent_run_completed,
)

# OpenTelemetry
from tracing import setup_tracing, inject_current_context

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
DYNAMIC_WORKFLOW_NAME = "dynamic_workflow"
AP_WORKFLOW_NAME = "ap_workflow"


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
    if metadata:
        return rpc(request, metadata=metadata)
    return rpc(request)


def _schedule_new_workflow_instance(
    workflow_name: str,
    instance_id: str,
    workflow_input: dict[str, Any],
    *,
    workflow_version: str | None = None,
) -> str:
    request = pb.CreateInstanceRequest(
        instanceId=instance_id,
        name=workflow_name,
        input=wrappers_pb2.StringValue(value=json.dumps(workflow_input)),
    )
    if workflow_version:
        request.version.CopyFrom(wrappers_pb2.StringValue(value=workflow_version))
    response = _taskhub_call("StartInstance", request)
    return str(response.instanceId)


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

    # Register activities
    wfr.register_activity(execute_action)
    wfr.register_activity(persist_state)
    wfr.register_activity(get_state)
    wfr.register_activity(delete_state)
    wfr.register_activity(publish_event)
    wfr.register_activity(publish_phase_changed)
    wfr.register_activity(publish_workflow_started)
    wfr.register_activity(publish_workflow_completed)
    wfr.register_activity(publish_workflow_failed)
    wfr.register_activity(publish_approval_requested)
    wfr.register_activity(log_external_event)
    wfr.register_activity(log_approval_request)
    wfr.register_activity(log_approval_response)
    wfr.register_activity(log_approval_timeout)
    # Node execution logging
    wfr.register_activity(log_node_start)
    wfr.register_activity(log_node_complete)
    # Persist final results to PostgreSQL
    wfr.register_activity(persist_results_to_db)
    # Agent service activities (durable-agent)
    wfr.register_activity(call_durable_agent_run)
    wfr.register_activity(call_durable_plan)
    wfr.register_activity(call_durable_execute_plan)
    wfr.register_activity(call_durable_execute_plan_dag)
    wfr.register_activity(terminate_ms_agent_run)
    wfr.register_activity(terminate_durable_agent_run)
    wfr.register_activity(cleanup_execution_workspaces)
    wfr.register_activity(track_agent_run_scheduled)
    wfr.register_activity(track_agent_run_completed)
    # AP workflow callback activities
    wfr.register_activity(send_ap_callback)
    wfr.register_activity(send_ap_step_update)
    # Sub-workflow support
    wfr.register_activity(fetch_child_workflow)

    logger.info("[Workflow Orchestrator] Registered all activities")

    # Register workflows (versioned for Dapr 1.17+ safe evolution).
    wfr.register_versioned_workflow(
        dynamic_workflow,
        name=DYNAMIC_WORKFLOW_NAME,
        version_name=config.DYNAMIC_WORKFLOW_VERSION,
        is_latest=True,
    )
    wfr.register_versioned_workflow(
        ap_workflow,
        name=AP_WORKFLOW_NAME,
        version_name=config.AP_WORKFLOW_VERSION,
        is_latest=True,
    )
    logger.info(
        "[Workflow Orchestrator] Registered workflows: %s@%s, %s@%s",
        DYNAMIC_WORKFLOW_NAME,
        config.DYNAMIC_WORKFLOW_VERSION,
        AP_WORKFLOW_NAME,
        config.AP_WORKFLOW_VERSION,
    )

    # Start the workflow runtime
    wfr.start()
    logger.info("[Workflow Orchestrator] Dapr Workflow Runtime started")

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

class WorkflowDefinitionModel(BaseModel):
    """Workflow definition model."""
    id: str
    name: str
    version: str = "1.0.0"
    nodes: list[dict[str, Any]]
    edges: list[dict[str, Any]]
    executionOrder: list[str]
    metadata: dict[str, Any] | None = None
    createdAt: str | None = None
    updatedAt: str | None = None


class StartWorkflowRequest(BaseModel):
    """Request to start a workflow."""
    definition: WorkflowDefinitionModel
    triggerData: dict[str, Any] = Field(default_factory=dict)
    integrations: dict[str, dict[str, str]] | None = None
    dbExecutionId: str | None = Field(
        default=None,
        description="Database execution ID for logging"
    )
    nodeConnectionMap: dict[str, str] | None = Field(
        default=None,
        description="Per-node connection external IDs for credential resolution"
    )
    workflowVersion: str | None = Field(
        default=None,
        description="Optional workflow version to start (Dapr versioned workflow)",
    )


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


class StartAPWorkflowRequest(BaseModel):
    """Request from AP's dapr-executor.ts to start an AP flow execution."""
    flowRunId: str
    projectId: str
    platformId: str | None = None
    flowVersionId: str | None = None
    flowId: str | None = None
    executionType: str = "BEGIN"
    triggerPayload: Any = None
    executeTrigger: bool = True
    progressUpdateType: str | None = None
    callbackUrl: str = ""
    flowVersion: dict[str, Any] = Field(default_factory=dict)


class StartAPWorkflowResponse(BaseModel):
    """Response from starting an AP workflow."""
    instanceId: str
    flowRunId: str
    status: str = "started"


class ExecuteByIdRequest(BaseModel):
    """Request to execute a workflow by its database ID."""
    workflowId: str
    triggerData: dict[str, Any] = Field(default_factory=dict)
    integrations: dict[str, dict[str, str]] | None = None
    nodeConnectionMap: dict[str, str] | None = None
    workflowVersion: str | None = None


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


def _registered_activity_names() -> list[str]:
    return [
        execute_action.__name__,
        persist_state.__name__,
        get_state.__name__,
        delete_state.__name__,
        publish_event.__name__,
        publish_phase_changed.__name__,
        publish_workflow_started.__name__,
        publish_workflow_completed.__name__,
        publish_workflow_failed.__name__,
        publish_approval_requested.__name__,
        log_external_event.__name__,
        log_approval_request.__name__,
        log_approval_response.__name__,
        log_approval_timeout.__name__,
        log_node_start.__name__,
        log_node_complete.__name__,
        persist_results_to_db.__name__,
        call_durable_agent_run.__name__,
        call_durable_plan.__name__,
        call_durable_execute_plan.__name__,
        call_durable_execute_plan_dag.__name__,
        terminate_ms_agent_run.__name__,
        terminate_durable_agent_run.__name__,
        cleanup_execution_workspaces.__name__,
        track_agent_run_scheduled.__name__,
        track_agent_run_completed.__name__,
        send_ap_callback.__name__,
        send_ap_step_update.__name__,
        fetch_child_workflow.__name__,
    ]


def _registered_workflow_descriptors() -> list[dict[str, Any]]:
    return [
        {
            "name": DYNAMIC_WORKFLOW_NAME,
            "version": config.DYNAMIC_WORKFLOW_VERSION,
            "aliases": [],
            "isLatest": True,
            "source": "service-introspection",
        },
        {
            "name": AP_WORKFLOW_NAME,
            "version": config.AP_WORKFLOW_VERSION,
            "aliases": [],
            "isLatest": True,
            "source": "service-introspection",
        },
    ]


# --- Database helpers for execute-by-id ---

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


def _fetch_workflow_from_db(workflow_id: str) -> dict[str, Any]:
    """Fetch a workflow definition from the database by ID."""
    import psycopg2

    db_url = _get_database_url()
    conn = psycopg2.connect(db_url)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, name, user_id, nodes, edges FROM workflows WHERE id = %s",
            (workflow_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")

        wf_id, wf_name, user_id, nodes_json, edges_json = row
        # JSONB columns may already be dicts/lists, or may need parsing
        nodes = json.loads(nodes_json) if isinstance(nodes_json, str) else nodes_json
        edges = json.loads(edges_json) if isinstance(edges_json, str) else edges_json

        return {
            "id": wf_id,
            "name": wf_name,
            "userId": user_id,
            "nodes": nodes,
            "edges": edges,
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
                    id, workflow_id, user_id, status, input, phase, progress
                )
                VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s)
                """,
                (
                    execution_id,
                    workflow_id,
                    user_id,
                    "running",
                    json.dumps(trigger_data or {}),
                    "running",
                    0,
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
                SET dapr_instance_id = %s, phase = %s, progress = %s
                WHERE id = %s
                """,
                (dapr_instance_id, "running", 0, execution_id),
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
    return str(config.get("actionType") or "").strip() == "durable/run"


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
    """Extract workflow ID from instance ID."""
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

    serialized_output = _parse_json_value(
        _parse_wrapped_string(getattr(orchestration_state, "output", None))
    )
    if isinstance(serialized_output, dict):
        outputs = serialized_output
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

@app.post("/api/v2/workflows", response_model=StartWorkflowResponse)
def start_workflow(request: StartWorkflowRequest):
    """
    Start a new workflow instance.

    POST /api/v2/workflows
    """
    try:
        definition = request.definition.model_dump()
        trigger_data = request.triggerData
        integrations = request.integrations
        db_execution_id = request.dbExecutionId

        selected_workflow_version = (
            request.workflowVersion
            or config.DYNAMIC_WORKFLOW_VERSION
        )

        # Build the input for the dynamic workflow
        workflow_input = {
            "definition": definition,
            "triggerData": trigger_data,
            "integrations": integrations,
            "dbExecutionId": db_execution_id,
            "nodeConnectionMap": request.nodeConnectionMap,
            "_workflowVersion": selected_workflow_version,
            "_otel": inject_current_context(),
        }

        # Generate a unique instance ID
        random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=7))
        instance_id = f"{definition['id']}-{int(time.time() * 1000)}-{random_suffix}"

        logger.info(f"[Workflow Routes] Starting workflow: {definition['name']} ({instance_id})")

        # Schedule the workflow
        result_id = _schedule_new_workflow_instance(
            workflow_name=DYNAMIC_WORKFLOW_NAME,
            instance_id=instance_id,
            workflow_input=workflow_input,
            workflow_version=selected_workflow_version,
        )

        logger.info(f"[Workflow Routes] Workflow scheduled: {result_id}")

        return StartWorkflowResponse(
            instanceId=result_id,
            workflowId=definition["id"],
            status="started",
            workflowVersion=selected_workflow_version,
        )

    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to start workflow: {e}")
        _raise_workflow_route_error("start_workflow", e)


@app.post("/api/v2/workflows/execute-by-id", response_model=StartWorkflowResponse)
def execute_workflow_by_id(request: ExecuteByIdRequest):
    """
    Execute a workflow by its database ID.

    POST /api/v2/workflows/execute-by-id

    Fetches the workflow definition from PostgreSQL, serializes it,
    computes execution order, and delegates to the dynamic workflow runtime.
    Intended for service-to-service invocation (e.g., MCP tools via Dapr).
    """
    try:
        # 1. Fetch workflow from DB
        wf = _fetch_workflow_from_db(request.workflowId)
        raw_nodes = wf["nodes"]
        raw_edges = wf["edges"]
        lowered_nodes, lowered_edges = _lower_while_nodes(raw_nodes, raw_edges)

        # 2. Filter out 'add' placeholder nodes
        exec_nodes = [
            n
            for n in lowered_nodes
            if n.get("type") != "add" and n.get("data", {}).get("type") != "add"
        ]

        # 3. Serialize nodes
        serialized_nodes = [_serialize_node(n) for n in exec_nodes]

        # 4. Filter edges to only reference existing nodes
        node_ids = {n["id"] for n in exec_nodes}
        serialized_edges = [
            {"id": e["id"], "source": e["source"], "target": e["target"],
             "sourceHandle": e.get("sourceHandle"), "targetHandle": e.get("targetHandle")}
            for e in lowered_edges
            if e["source"] in node_ids and e["target"] in node_ids
        ]

        # 5. Compute execution order
        execution_order = _topological_sort(
            [{"id": n["id"], "type": n["type"]} for n in serialized_nodes],
            serialized_edges,
        )

        # 6. Build definition
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).isoformat()
        definition = {
            "id": wf["id"],
            "name": wf["name"],
            "version": "1.0.0",
            "nodes": serialized_nodes,
            "edges": serialized_edges,
            "executionOrder": execution_order,
            "createdAt": now,
            "updatedAt": now,
        }

        # 6.5 Create DB execution row so durable-agent plan artifacts and run
        # tracking always have a valid workflow_executions foreign key.
        db_execution_id = _create_workflow_execution(
            workflow_id=wf["id"],
            user_id=wf["userId"],
            trigger_data=request.triggerData,
        )

        # 7. Schedule via the existing start_workflow logic
        selected_workflow_version = (
            request.workflowVersion
            or config.DYNAMIC_WORKFLOW_VERSION
        )
        workflow_input = {
            "definition": definition,
            "triggerData": request.triggerData,
            "integrations": request.integrations,
            "dbExecutionId": db_execution_id,
            "nodeConnectionMap": request.nodeConnectionMap,
            "_workflowVersion": selected_workflow_version,
            "_otel": inject_current_context(),
        }

        random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=7))
        instance_id = f"{wf['id']}-{int(time.time() * 1000)}-{random_suffix}"

        logger.info(f"[Execute-By-Id] Starting workflow: {wf['name']} ({instance_id})")

        result_id = _schedule_new_workflow_instance(
            workflow_name=DYNAMIC_WORKFLOW_NAME,
            instance_id=instance_id,
            workflow_input=workflow_input,
            workflow_version=selected_workflow_version,
        )

        _mark_workflow_execution_started(db_execution_id, result_id)

        logger.info(f"[Execute-By-Id] Workflow scheduled: {result_id}")

        return StartWorkflowResponse(
            instanceId=result_id,
            workflowId=wf["id"],
            status="started",
            workflowVersion=selected_workflow_version,
        )

    except HTTPException:
        raise
    except Exception as e:
        try:
            if "db_execution_id" in locals():
                _mark_workflow_execution_failed_to_start(
                    db_execution_id,
                    str(e),
                )
        except Exception as persist_err:
            logger.error(
                f"[Execute-By-Id] Failed to mark execution start failure: {persist_err}"
            )
        logger.error(f"[Execute-By-Id] Failed to execute workflow: {e}")
        _raise_workflow_route_error("execute_workflow_by_id", e)


@app.post("/api/v2/ap-workflows", response_model=StartAPWorkflowResponse)
def start_ap_workflow(request: StartAPWorkflowRequest):
    """
    Start an AP flow execution via Dapr workflow.

    POST /api/v2/ap-workflows

    Called by AP's dapr-executor.ts when AP_EXECUTION_ENGINE=dapr.
    Receives the full FlowVersion JSON and walks the AP action chain
    using the Dapr workflow runtime.
    """
    try:
        client = get_workflow_client()
        selected_workflow_version = config.AP_WORKFLOW_VERSION

        workflow_input = {
            "flowRunId": request.flowRunId,
            "projectId": request.projectId,
            "platformId": request.platformId,
            "flowVersionId": request.flowVersionId,
            "flowId": request.flowId,
            "executionType": request.executionType,
            "triggerPayload": request.triggerPayload,
            "executeTrigger": request.executeTrigger,
            "progressUpdateType": request.progressUpdateType,
            "callbackUrl": request.callbackUrl,
            "flowVersion": request.flowVersion,
            "_workflowVersion": selected_workflow_version,
        }

        # Use the AP flow run ID as the Dapr instance ID (1:1 mapping).
        # This makes monitor/status queries and resume events trivial and avoids UI confusion.
        instance_id = request.flowRunId

        logger.info(
            f"[AP Workflow] Starting AP flow: run={request.flowRunId}, "
            f"flow={request.flowVersion.get('displayName', 'unknown')}, "
            f"instance={instance_id}"
        )

        # Idempotent start: if the instance already exists, return it.
        try:
            _schedule_new_workflow_instance(
                workflow_name=AP_WORKFLOW_NAME,
                instance_id=instance_id,
                workflow_input=workflow_input,
                workflow_version=selected_workflow_version,
            )
        except Exception:
            existing = client.get_workflow_state(instance_id=instance_id, fetch_payloads=False)
            if existing is None:
                raise

        logger.info(f"[AP Workflow] Workflow scheduled: {instance_id}")

        return StartAPWorkflowResponse(
            instanceId=instance_id,
            flowRunId=request.flowRunId,
            status="started",
        )

    except Exception as e:
        logger.error(f"[AP Workflow] Failed to start AP workflow: {e}")
        _raise_workflow_route_error("start_ap_workflow", e)


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

    This endpoint receives CloudEvents from Dapr pub/sub when durable-agent
    publishes completion events. It forwards the events as external events to
    waiting parent workflows.
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
            {"name": name, "source": "service-introspection"}
            for name in _registered_activity_names()
        ],
        errors=errors,
        additional={
            "config": {
                "dynamicWorkflowVersion": config.DYNAMIC_WORKFLOW_VERSION,
                "apWorkflowVersion": config.AP_WORKFLOW_VERSION,
                "stateStoreName": config.STATE_STORE_NAME,
                "pubsubName": config.PUBSUB_NAME,
                "durableAgentAppId": config.DURABLE_AGENT_APP_ID,
            },
        },
    )


# Entry point for uvicorn
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)
