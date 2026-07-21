from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from dapr.ext.workflow import DaprWorkflowClient, WorkflowRuntime
from fastapi import FastAPI, HTTPException
from google.protobuf import wrappers_pb2

from src.cancellation import (
    _save_session_cancellation_request,
    check_cancellation_activity,
)
from src.claude_sdk_runner import run_claude_sdk_turn_activity
from src.run_status import AgentRunNotFoundError, resolve_agent_run_status
from src.session_config import (
    TERMINAL_CONTROL_EVENT_TYPES,
    external_control_event_as_user_event,
)
from src.session_workflow import session_workflow

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

_runtime = WorkflowRuntime()
_runtime.register_workflow(session_workflow, name="session_workflow")
_runtime.register_activity(run_claude_sdk_turn_activity)
_runtime.register_activity(check_cancellation_activity)
_runtime_running = False


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _runtime_running
    logger.info("[claude-agent-py] starting Dapr workflow runtime")
    _runtime.start()
    _runtime_running = True
    try:
        yield
    finally:
        logger.info("[claude-agent-py] shutting down Dapr workflow runtime")
        _runtime.shutdown()
        _runtime_running = False


app = FastAPI(title="claude-agent-py", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "runtime": "claude-agent-py"}


@app.get("/readyz")
def readyz() -> dict[str, object]:
    return {"status": "ok", "running": _runtime_running}


@app.get("/api/v2/agent-runs/{instance_id}/status")
def get_agent_run_status(instance_id: str, summary: bool = False) -> dict[str, Any]:
    try:
        return resolve_agent_run_status(
            instance_id,
            summary=summary,
            app_id=os.environ.get("AGENT_SERVICE_NAME", "claude-agent-py"),
            client_factory=DaprWorkflowClient,
        )
    except AgentRunNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _taskhub_call(method: str, request: Any) -> Any:
    import grpc
    import dapr.ext.workflow._durabletask.internal.orchestrator_service_pb2_grpc as pb_grpc

    target = (
        f"{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_GRPC_PORT', '50001')}"
    )
    timeout_seconds = float(os.environ.get("TASKHUB_RPC_TIMEOUT_SECONDS", "15"))
    stub = pb_grpc.TaskHubSidecarServiceStub(grpc.insecure_channel(target))
    return getattr(stub, method)(request, timeout=timeout_seconds)


@app.post("/internal/sessions/spawn")
def spawn_session_endpoint(request: dict[str, Any]) -> dict[str, Any]:
    import dapr.ext.workflow._durabletask.internal.protos as pb

    instance_id = str(request.get("instanceId") or "").strip()
    if not instance_id:
        raise HTTPException(status_code=400, detail="instanceId is required")
    payload = request.get("payload") or {}

    create_request = pb.CreateInstanceRequest(
        instanceId=instance_id,
        name="session_workflow",
        input=wrappers_pb2.StringValue(value=json.dumps(payload)),
    )
    try:
        _taskhub_call("StartInstance", create_request)
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if "already exists" in msg.lower() or "ALREADY_EXISTS" in msg:
            logger.info("[spawn] instance %s already exists - reusing", instance_id)
        else:
            logger.exception("[spawn] StartInstance failed for %s", instance_id)
            raise HTTPException(status_code=500, detail=f"StartInstance failed: {msg}")

    return {"instanceId": instance_id, "ok": True}


@app.post("/internal/sessions/raise-event")
def raise_session_event_endpoint(request: dict[str, Any]) -> dict[str, Any]:
    import dapr.ext.workflow._durabletask.internal.protos as pb

    instance_id = str(request.get("instanceId") or "").strip()
    event_name = str(request.get("eventName") or "").strip()
    payload = request.get("payload") or {}
    if not instance_id or not event_name:
        raise HTTPException(status_code=400, detail="instanceId + eventName required")
    # Persist a cooperative-cancel flag for terminal control events so the
    # session workflow halts between turns even if the re-raised event is missed.
    if event_name in TERMINAL_CONTROL_EVENT_TYPES:
        try:
            _save_session_cancellation_request(instance_id, event_name, payload)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[raise-event] failed to persist cancel flag for %s: %s", instance_id, exc
            )
    event_name, payload = external_control_event_as_user_event(event_name, payload)

    raise_request = pb.RaiseEventRequest(
        instanceId=instance_id,
        name=event_name,
        input=wrappers_pb2.StringValue(value=json.dumps(payload)),
    )
    try:
        _taskhub_call("RaiseEvent", raise_request)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"RaiseEvent failed: {exc}")

    return {"ok": True}


# ---------------------------------------------------------------------------
# Agent-run management surface (parity with dapr-agent-py). The BFF lifecycle
# controller + benchmark cascade invoke these over Dapr service-invoke.
# ---------------------------------------------------------------------------


def _agent_run_already_gone(exc: Exception) -> bool:
    msg = str(exc).lower()
    return (
        "no such instance" in msg
        or "not found" in msg
        or "does not exist" in msg
        or "no workflow" in msg
    )


@app.post("/api/v2/agent-runs/{instance_id}/terminate")
def terminate_agent_run(
    instance_id: str, body: dict[str, Any] | None = None
) -> dict[str, Any]:
    try:
        DaprWorkflowClient().terminate_workflow(instance_id=instance_id)
        return {"success": True, "instanceId": instance_id}
    except Exception as exc:  # noqa: BLE001
        if _agent_run_already_gone(exc):
            logger.info("[agent-runs] terminate skipped for %s: already gone", instance_id)
            return {"success": True, "instanceId": instance_id, "alreadyGone": True}
        logger.error("[agent-runs] terminate failed for %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/v2/agent-runs/{instance_id}/pause")
def pause_agent_run(instance_id: str) -> dict[str, Any]:
    try:
        DaprWorkflowClient().pause_workflow(instance_id=instance_id)
        return {"success": True, "instanceId": instance_id}
    except Exception as exc:  # noqa: BLE001
        logger.error("[agent-runs] pause failed for %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/v2/agent-runs/{instance_id}/resume")
def resume_agent_run(instance_id: str) -> dict[str, Any]:
    try:
        DaprWorkflowClient().resume_workflow(instance_id=instance_id)
        return {"success": True, "instanceId": instance_id}
    except Exception as exc:  # noqa: BLE001
        logger.error("[agent-runs] resume failed for %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.delete("/api/v2/agent-runs/{instance_id}")
def purge_agent_run(
    instance_id: str, force: bool = False, recursive: bool = False
) -> dict[str, Any]:
    try:
        DaprWorkflowClient().purge_workflow(instance_id=instance_id)
        return {
            "success": True,
            "instanceId": instance_id,
            "force": force,
            "recursive": recursive,
            "purgeAccepted": True,
            "isComplete": True,
        }
    except Exception as exc:  # noqa: BLE001
        if _agent_run_already_gone(exc):
            logger.info("[agent-runs] purge skipped for %s: already gone", instance_id)
            return {
                "success": True,
                "instanceId": instance_id,
                "force": force,
                "recursive": recursive,
                "alreadyGone": True,
                "isComplete": True,
            }
        logger.error("[agent-runs] purge failed for %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
