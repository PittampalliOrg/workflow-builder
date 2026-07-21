"""pydantic-ai-agent-py — durable coding agent service.

FastAPI on :8002 hosting a plain ``dapr.ext.workflow.WorkflowRuntime`` with
the platform ``session_workflow`` + the Diagrid-pattern ``agent_workflow``
(every LLM message and every tool call its own durable activity), tools from
pydantic-ai-harness, default model kimi-k3.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from typing import Any


def _configure_durabletask_grpc_defaults() -> None:
    """Raise durabletask's channel limit before any workflow runtime starts
    (16 MiB — matches dapr.io/max-body-size on sandbox + orchestrator pods)."""
    try:
        import dapr.ext.workflow._durabletask.internal.shared as durabletask_shared
    except Exception:  # noqa: BLE001
        return
    try:
        max_message_bytes = max(
            1, int(os.environ.get("DAPR_WORKFLOW_GRPC_MAX_MESSAGE_BYTES", "16777216"))
        )
    except ValueError:
        max_message_bytes = 16 * 1024 * 1024
    existing = getattr(durabletask_shared, "DEFAULT_GRPC_KEEPALIVE_OPTIONS", ())
    merged = {
        str(key): value for key, value in existing if isinstance(key, str) and key
    }
    merged.setdefault("grpc.max_receive_message_length", max_message_bytes)
    merged.setdefault("grpc.max_send_message_length", max_message_bytes)
    durabletask_shared.DEFAULT_GRPC_KEEPALIVE_OPTIONS = tuple(merged.items())


_configure_durabletask_grpc_defaults()

import dapr.ext.workflow as wf  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from google.protobuf import wrappers_pb2  # noqa: E402

from src.config import AGENT_SERVICE_NAME, AGENT_STATE_STORE, WORKSPACE_ROOT  # noqa: E402
from src.event_publisher import set_incremental_tier_enabled  # noqa: E402
from src.run_status import AgentRunNotFoundError, resolve_agent_run_status  # noqa: E402
from src.session import session_workflow  # noqa: E402
from src.session_config import (  # noqa: E402
    TERMINAL_CONTROL_EVENT_TYPES,
    external_control_event_as_user_event,
)
from src.workflow import (  # noqa: E402
    CALL_LLM_ACTIVITY,
    CHECK_CANCELLATION_ACTIVITY,
    EXECUTE_TOOL_ACTIVITY,
    _session_cancel_state_key,
    agent_workflow,
    call_llm,
    check_cancellation,
    execute_tool,
)

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(AGENT_SERVICE_NAME)

set_incremental_tier_enabled(True)

# OTel (traces + metrics + logs → collector); no-op without
# OTEL_EXPORTER_OTLP_ENDPOINT. Must run before the workflow runtime starts so
# activity spans + pydantic-ai's native instrumentation see the global
# providers.
from src.telemetry import init_telemetry  # noqa: E402

init_telemetry()

runtime = wf.WorkflowRuntime()
runtime.register_workflow(session_workflow)
runtime.register_workflow(agent_workflow)
runtime.register_activity(call_llm, name=CALL_LLM_ACTIVITY)
runtime.register_activity(execute_tool, name=EXECUTE_TOOL_ACTIVITY)
runtime.register_activity(check_cancellation, name=CHECK_CANCELLATION_ACTIVITY)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        "%s starting (workspace=%s, statestore=%s)",
        AGENT_SERVICE_NAME,
        WORKSPACE_ROOT,
        AGENT_STATE_STORE,
    )
    runtime.start()
    yield
    logger.info("%s shutting down", AGENT_SERVICE_NAME)
    try:
        runtime.shutdown()
    except Exception as exc:  # noqa: BLE001
        logger.warning("runtime shutdown failed: %s", exc)


app = FastAPI(
    title=AGENT_SERVICE_NAME,
    description=(
        "Durable pydantic-ai coding agent (per-activity LLM/tool execution, "
        "kimi-k3, pydantic-ai-harness tools)"
    ),
    version="0.1.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Dapr sidecar helpers (same shapes as dapr-agent-py / browser-use-agent)
# ---------------------------------------------------------------------------


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


def _save_agent_state_key(key: str, value: Any) -> None:
    sidecar = (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )
    encoded_key = urllib.parse.quote(key, safe="")
    payload = json.dumps(
        [{"key": key, "value": value, "metadata": {"partitionKey": encoded_key}}]
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{sidecar}/v1.0/state/{AGENT_STATE_STORE}",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=5)


def _save_session_cancellation_request(
    instance_id: str, event_name: str, payload: Any
) -> None:
    event: dict[str, Any] = {"type": event_name}
    if isinstance(payload, dict):
        event.update(payload)
    else:
        event["data"] = payload
    _save_agent_state_key(_session_cancel_state_key(instance_id), event)


def _workflow_http_post(instance_id: str, action: str) -> tuple[int, str]:
    sidecar = (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )
    encoded = urllib.parse.quote(instance_id, safe="")
    req = urllib.request.Request(
        f"{sidecar}/v1.0/workflows/dapr/{encoded}/{action}", data=b"", method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status, ""
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")[:300]


# ---------------------------------------------------------------------------
# Platform endpoints
# ---------------------------------------------------------------------------


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "service": AGENT_SERVICE_NAME}


@app.get("/readyz")
def readyz() -> dict:
    return {"ok": True, "service": AGENT_SERVICE_NAME}


@app.get("/agent/instances/{instance_id}")
def get_instance(instance_id: str) -> dict:
    client = wf.DaprWorkflowClient()
    state = client.get_workflow_state(instance_id, fetch_payloads=True)
    if state is None:
        raise HTTPException(status_code=404, detail="instance not found")
    return {
        "instance_id": instance_id,
        "runtime_status": getattr(state.runtime_status, "name", str(state.runtime_status)),
        "serialized_input": state.serialized_input,
        "serialized_output": state.serialized_output,
    }


@app.get("/api/v2/agent-runs/{instance_id}/status")
def get_agent_run_status(instance_id: str, summary: bool = False) -> dict:
    """Return the platform-wide durable runtime status contract.

    Lifecycle callers use this endpoint for every runtime. Per-session Sandbox
    hosts are reached directly on their app port, so the Pydantic runtime must
    expose the same route as dapr-agent-py rather than relying on Dapr service
    invocation to translate its legacy ``/agent/instances`` endpoint.
    """
    try:
        return resolve_agent_run_status(
            instance_id,
            summary=summary,
            app_id=AGENT_SERVICE_NAME,
            client_factory=wf.DaprWorkflowClient,
        )
    except AgentRunNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/internal/sessions/spawn")
def spawn_session_endpoint(request: dict) -> dict:
    """Start a session_workflow instance on this sidecar (BFF bridge — the
    BFF's own sidecar has no workflow runtime; body {instanceId, payload})."""
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
            logger.info("[spawn] instance %s already exists — reusing", instance_id)
        else:
            logger.exception("[spawn] StartInstance failed for %s", instance_id)
            raise HTTPException(status_code=500, detail=f"StartInstance failed: {msg}")

    return {"instanceId": instance_id, "ok": True}


@app.post("/internal/sessions/raise-event")
def raise_session_event_endpoint(request: dict) -> dict:
    """Raise an external event into a running session_workflow instance.
    Terminal control events persist the cancel key FIRST so in-flight agent
    loops observe it between activities."""
    import dapr.ext.workflow._durabletask.internal.protos as pb

    instance_id = str(request.get("instanceId") or "").strip()
    event_name = str(request.get("eventName") or "").strip()
    payload = request.get("payload") or {}
    if not instance_id or not event_name:
        raise HTTPException(status_code=400, detail="instanceId + eventName required")
    if event_name in TERMINAL_CONTROL_EVENT_TYPES:
        try:
            _save_session_cancellation_request(instance_id, event_name, payload)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[session] failed to persist cancellation request for %s: %s",
                instance_id,
                exc,
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


@app.post("/api/v2/agent-runs/{instance_id}/terminate")
def terminate_agent_run(instance_id: str) -> dict:
    try:
        _save_session_cancellation_request(
            instance_id, "session.terminate", {"reason": "terminate requested"}
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[terminate] cancel-key persist failed for %s: %s", instance_id, exc)
    status, detail = _workflow_http_post(instance_id, "terminate")
    if status >= 400 and status != 404:
        raise HTTPException(status_code=status, detail=detail or "terminate failed")
    return {"ok": True, "instanceId": instance_id, "status": status}


@app.post("/api/v2/agent-runs/{instance_id}/pause")
def pause_agent_run(instance_id: str) -> dict:
    status, detail = _workflow_http_post(instance_id, "pause")
    if status >= 400:
        raise HTTPException(status_code=status, detail=detail or "pause failed")
    return {"ok": True, "instanceId": instance_id}


@app.post("/api/v2/agent-runs/{instance_id}/resume")
def resume_agent_run(instance_id: str) -> dict:
    status, detail = _workflow_http_post(instance_id, "resume")
    if status >= 400:
        raise HTTPException(status_code=status, detail=detail or "resume failed")
    return {"ok": True, "instanceId": instance_id}


@app.delete("/api/v2/agent-runs/{instance_id}")
def purge_agent_run(instance_id: str) -> dict:
    status, detail = _workflow_http_post(instance_id, "purge")
    if status >= 400 and status != 404:
        raise HTTPException(status_code=status, detail=detail or "purge failed")
    return {"ok": True, "instanceId": instance_id, "status": status}
