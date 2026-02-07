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

KEY FEATURE: Native multi-app child workflow support for planner/* actions.
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
from activities.call_planner_service import (
    call_planner_clone,
    call_planner_plan,
    call_planner_execute,
    call_planner_execute_standalone,
    call_planner_workflow,
    call_planner_approve,
    call_planner_status,
    call_planner_multi_step,
)
from activities.log_node_execution import log_node_start, log_node_complete
from subscriptions.planner_events import handle_planner_event

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
    # Node execution logging (planner/* nodes that bypass function-router)
    wfr.register_activity(log_node_start)
    wfr.register_activity(log_node_complete)
    # Planner service activities (planner-dapr-agent)
    wfr.register_activity(call_planner_clone)
    wfr.register_activity(call_planner_plan)
    wfr.register_activity(call_planner_execute)
    wfr.register_activity(call_planner_execute_standalone)
    wfr.register_activity(call_planner_workflow)
    wfr.register_activity(call_planner_approve)
    wfr.register_activity(call_planner_status)
    wfr.register_activity(call_planner_multi_step)

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


class WorkflowStatusResponse(BaseModel):
    """Workflow status response."""
    instanceId: str
    workflowId: str
    runtimeStatus: str
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

        # Use the AP flow run ID as the Dapr instance ID for traceability
        import time
        import random
        import string
        random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=7))
        instance_id = f"ap-{request.flowRunId}-{random_suffix}"

        logger.info(
            f"[AP Workflow] Starting AP flow: run={request.flowRunId}, "
            f"flow={request.flowVersion.get('displayName', 'unknown')}, "
            f"instance={instance_id}"
        )

        result_id = client.schedule_new_workflow(
            workflow=ap_workflow,
            input=workflow_input,
            instance_id=instance_id,
        )

        logger.info(f"[AP Workflow] Workflow scheduled: {result_id}")

        return StartAPWorkflowResponse(
            instanceId=result_id,
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

@app.post("/subscriptions/planner-events")
def planner_events_subscription(event: CloudEvent):
    """
    Handle planner completion events from pub/sub.

    This endpoint receives CloudEvents from Dapr pub/sub when planner-dapr-agent
    publishes completion events. It forwards the events as external events to
    waiting parent workflows.

    Subscribed topics (configured via Dapr Subscription resource):
    - workflow.events (filtered by event type: planner_planning_completed, planner_execution_completed)
    """
    logger.info(f"[Subscription] Received planner event: {event.type}")

    result = handle_planner_event(event.type, event.data)

    # Return success even on logical failures to acknowledge the message
    # (prevents Dapr from retrying indefinitely)
    return {"status": "SUCCESS", "result": result}


@app.options("/subscriptions/planner-events")
def planner_events_subscription_options():
    """CORS preflight handler for Dapr subscription endpoint."""
    return {}


# Programmatic subscription declaration (alternative to Subscription YAML)
# Note: This is a fallback - we prefer declarative Subscription CRD in stacks/main
# Dapr will call this endpoint to discover subscriptions
PUBSUB_NAME = config.PUBSUB_NAME

@app.get("/dapr/subscribe")
def subscribe():
    """
    Declare pub/sub subscriptions for Dapr.

    This endpoint tells Dapr which topics this service subscribes to.
    Alternative to declarative Subscription CRD.

    Note: The declarative Subscription-planner-events.yaml is preferred
    and should take precedence when deployed to Kubernetes.
    """
    return [
        {
            "pubsubname": PUBSUB_NAME,
            "topic": "workflow.events",
            "route": "/subscriptions/planner-events",
            "routes": {
                "rules": [
                    {
                        "match": "event.type == \"planner_planning_completed\"",
                        "path": "/subscriptions/planner-events"
                    },
                    {
                        "match": "event.type == \"planner_execution_completed\"",
                        "path": "/subscriptions/planner-events"
                    },
                ],
                "default": "/subscriptions/planner-events"
            }
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
