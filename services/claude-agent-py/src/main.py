from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from dapr.ext.workflow import WorkflowRuntime
from fastapi import FastAPI, HTTPException
from google.protobuf import wrappers_pb2

from src.claude_sdk_runner import run_claude_sdk_turn_activity
from src.session_config import external_control_event_as_user_event
from src.session_workflow import session_workflow

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

_runtime = WorkflowRuntime()
_runtime.register_workflow(session_workflow, name="session_workflow")
_runtime.register_activity(run_claude_sdk_turn_activity)
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


def _taskhub_call(method: str, request: Any) -> Any:
    import grpc
    import durabletask.internal.orchestrator_service_pb2_grpc as pb_grpc

    target = (
        f"{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_GRPC_PORT', '50001')}"
    )
    timeout_seconds = float(os.environ.get("TASKHUB_RPC_TIMEOUT_SECONDS", "15"))
    stub = pb_grpc.TaskHubSidecarServiceStub(grpc.insecure_channel(target))
    return getattr(stub, method)(request, timeout=timeout_seconds)


@app.post("/internal/sessions/spawn")
def spawn_session_endpoint(request: dict[str, Any]) -> dict[str, Any]:
    import durabletask.internal.orchestrator_service_pb2 as pb

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
    import durabletask.internal.orchestrator_service_pb2 as pb

    instance_id = str(request.get("instanceId") or "").strip()
    event_name = str(request.get("eventName") or "").strip()
    payload = request.get("payload") or {}
    if not instance_id or not event_name:
        raise HTTPException(status_code=400, detail="instanceId + eventName required")
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
