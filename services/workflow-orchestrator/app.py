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

KEY FEATURE: Native multi-app child workflow support for agent actions via mastra-agent-tanstack.
"""

from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from typing import Any

from dapr.ext.workflow import DaprWorkflowClient
from fastapi import FastAPI, HTTPException
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
    call_mastra_agent_run,
    call_durable_agent_run,
    call_durable_plan,
    call_durable_execute_plan,
    cleanup_execution_workspaces,
)
from activities.log_node_execution import log_node_start, log_node_complete
from activities.persist_results_to_db import persist_results_to_db
from activities.send_ap_callback import send_ap_callback, send_ap_step_update

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
    # Agent service activities (mastra-agent-tanstack)
    wfr.register_activity(call_mastra_agent_run)
    wfr.register_activity(call_durable_agent_run)
    wfr.register_activity(call_durable_plan)
    wfr.register_activity(call_durable_execute_plan)
    wfr.register_activity(cleanup_execution_workspaces)
    # AP workflow callback activities
    wfr.register_activity(send_ap_callback)
    wfr.register_activity(send_ap_step_update)

    logger.info("[Workflow Orchestrator] Registered all activities")

    # Register workflows
    wfr.register_workflow(ap_workflow)
    logger.info("[Workflow Orchestrator] Registered AP workflow")

    # Start the workflow runtime
    wfr.start()
    logger.info("[Workflow Orchestrator] Dapr Workflow Runtime started")

    yield

    # Shutdown
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


class StartWorkflowResponse(BaseModel):
    """Response from starting a workflow."""
    instanceId: str
    workflowId: str
    status: str = "started"


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


class WorkflowStatusResponse(BaseModel):
    """Workflow status response."""
    instanceId: str
    workflowId: str
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
    startedAt: str | None = None
    completedAt: str | None = None


# --- Helper Functions ---

def get_workflow_client() -> DaprWorkflowClient:
    """Get a Dapr workflow client."""
    return DaprWorkflowClient()


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


def _mark_workflow_execution_started(execution_id: str, dapr_instance_id: str) -> None:
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
        "WORKFLOW_RUNTIME_STATUS_TERMINATED": "TERMINATED",
        "WORKFLOW_RUNTIME_STATUS_PENDING": "PENDING",
        "WORKFLOW_RUNTIME_STATUS_SUSPENDED": "SUSPENDED",
        # Handle string values
        "RUNNING": "RUNNING",
        "COMPLETED": "COMPLETED",
        "FAILED": "FAILED",
        "TERMINATED": "TERMINATED",
        "PENDING": "PENDING",
        "SUSPENDED": "SUSPENDED",
    }
    return status_map.get(str(dapr_status), "UNKNOWN")


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

        client = get_workflow_client()

        # Build the input for the dynamic workflow
        workflow_input = {
            "definition": definition,
            "triggerData": trigger_data,
            "integrations": integrations,
            "dbExecutionId": db_execution_id,
            "nodeConnectionMap": request.nodeConnectionMap,
            "_otel": inject_current_context(),
        }

        # Generate a unique instance ID
        import time
        import random
        import string
        random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=7))
        instance_id = f"{definition['id']}-{int(time.time() * 1000)}-{random_suffix}"

        logger.info(f"[Workflow Routes] Starting workflow: {definition['name']} ({instance_id})")

        # Schedule the workflow
        result_id = client.schedule_new_workflow(
            workflow=dynamic_workflow,
            input=workflow_input,
            instance_id=instance_id,
        )

        logger.info(f"[Workflow Routes] Workflow scheduled: {result_id}")

        return StartWorkflowResponse(
            instanceId=result_id,
            workflowId=definition["id"],
            status="started",
        )

    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to start workflow: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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
        client = get_workflow_client()
        workflow_input = {
            "definition": definition,
            "triggerData": request.triggerData,
            "integrations": request.integrations,
            "dbExecutionId": db_execution_id,
            "nodeConnectionMap": request.nodeConnectionMap,
            "_otel": inject_current_context(),
        }

        import time
        import random
        import string
        random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=7))
        instance_id = f"{wf['id']}-{int(time.time() * 1000)}-{random_suffix}"

        logger.info(f"[Execute-By-Id] Starting workflow: {wf['name']} ({instance_id})")

        result_id = client.schedule_new_workflow(
            workflow=dynamic_workflow,
            input=workflow_input,
            instance_id=instance_id,
        )

        _mark_workflow_execution_started(db_execution_id, result_id)

        logger.info(f"[Execute-By-Id] Workflow scheduled: {result_id}")

        return StartWorkflowResponse(
            instanceId=result_id,
            workflowId=wf["id"],
            status="started",
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
        raise HTTPException(status_code=500, detail=str(e))


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
            client.schedule_new_workflow(
                workflow=ap_workflow,
                input=workflow_input,
                instance_id=instance_id,
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
        raise HTTPException(status_code=500, detail=str(e))


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


@app.get("/api/v2/workflows/{instance_id}/status", response_model=WorkflowStatusResponse)
def get_workflow_status(instance_id: str):
    """
    Get workflow status.

    GET /api/v2/workflows/:instanceId/status
    """
    try:
        client = get_workflow_client()
        state = client.get_workflow_state(instance_id=instance_id, fetch_payloads=True)

        if state is None:
            raise HTTPException(status_code=404, detail="Workflow not found")

        # Get runtime status
        runtime_status = "UNKNOWN"
        if hasattr(state, "runtime_status") and state.runtime_status:
            runtime_status = (
                state.runtime_status.name
                if hasattr(state.runtime_status, "name")
                else str(state.runtime_status)
            )

        runtime_status = map_runtime_status(runtime_status)

        # Parse custom status and output
        phase = None
        progress = 0
        message = None
        current_node_id = None
        current_node_name = None
        approval_event_name = None
        trace_id = None
        outputs = None
        error = None
        started_at = None
        completed_at = None

        if hasattr(state, "to_json"):
            state_dict = state.to_json()
            if isinstance(state_dict, dict):
                # Custom status
                custom_str = state_dict.get("serialized_custom_status")
                if custom_str:
                    try:
                        parsed = json.loads(custom_str)
                        while isinstance(parsed, str):
                            parsed = json.loads(parsed)
                        if isinstance(parsed, dict):
                            phase = parsed.get("phase")
                            progress = parsed.get("progress", 0)
                            message = parsed.get("message")
                            current_node_id = parsed.get("currentNodeId")
                            current_node_name = parsed.get("currentNodeName")
                            approval_event_name = parsed.get("approvalEventName")
                            trace_id = parsed.get("traceId") or parsed.get("trace_id")
                    except (json.JSONDecodeError, TypeError):
                        pass

                # Output
                output_str = state_dict.get("serialized_output")
                if output_str:
                    try:
                        parsed = json.loads(output_str)
                        while isinstance(parsed, str):
                            parsed = json.loads(parsed)
                        outputs = parsed if isinstance(parsed, dict) else {"raw": str(parsed)}
                    except (json.JSONDecodeError, TypeError):
                        outputs = {"raw": str(output_str)}

                # Failure details
                failure = state_dict.get("failure_details")
                if failure:
                    error = failure.get("message")

        # Timestamps
        if hasattr(state, "created_at") and state.created_at:
            started_at = (
                state.created_at.isoformat()
                if hasattr(state.created_at, "isoformat")
                else str(state.created_at)
            )

        if runtime_status in ("COMPLETED", "FAILED"):
            if hasattr(state, "last_updated_at") and state.last_updated_at:
                completed_at = (
                    state.last_updated_at.isoformat()
                    if hasattr(state.last_updated_at, "isoformat")
                    else str(state.last_updated_at)
                )

        return WorkflowStatusResponse(
            instanceId=instance_id,
            workflowId=instance_id.split("-")[0],
            runtimeStatus=runtime_status,
            traceId=trace_id,
            phase=phase or (runtime_status.lower() if runtime_status in ("RUNNING", "PENDING") else None),
            progress=progress,
            message=message,
            currentNodeId=current_node_id,
            currentNodeName=current_node_name,
            approvalEventName=approval_event_name,
            outputs=outputs,
            error=error,
            startedAt=started_at,
            completedAt=completed_at,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to get workflow status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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
        raise HTTPException(status_code=500, detail=str(e))


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

        client.terminate_workflow(instance_id=instance_id, output=request.reason)

        return {
            "success": True,
            "instanceId": instance_id,
        }

    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to terminate workflow: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/v2/workflows/{instance_id}")
def purge_workflow(instance_id: str):
    """
    Purge a completed workflow.

    DELETE /api/v2/workflows/:instanceId
    """
    try:
        client = get_workflow_client()

        logger.info(f"[Workflow Routes] Purging workflow: {instance_id}")

        client.purge_workflow(instance_id=instance_id)

        return {
            "success": True,
            "instanceId": instance_id,
        }

    except Exception as e:
        logger.error(f"[Workflow Routes] Failed to purge workflow: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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
        raise HTTPException(status_code=500, detail=str(e))


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
        raise HTTPException(status_code=500, detail=str(e))


# --- Pub/Sub Subscription Routes ---

@app.post("/subscriptions/agent-events")
def agent_events_subscription(event: CloudEvent):
    """
    Handle agent completion events from pub/sub.

    This endpoint receives CloudEvents from Dapr pub/sub when mastra-agent-tanstack
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
    return {"status": "ready", "service": "workflow-orchestrator"}


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


# Entry point for uvicorn
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)
