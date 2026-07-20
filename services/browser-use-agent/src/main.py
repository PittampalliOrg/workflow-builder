"""browser-use-agent — standalone durable browser agent service.

FastAPI app on :8002 hosting a dapr-agents ``DurableAgent`` whose inner loop
is the browser-use framework (see ``src/executor.py``), default model
kimi-k3. Boots exactly like dapr-agent-py: ``AgentRunner().serve(agent,
app=app, port=8002)`` wires pub/sub + HTTP routes and starts the Dapr
workflow runtime; the BFF/orchestrator dispatch ``session_workflow`` via
placement or the ``/internal/sessions/spawn`` bridge below.
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

from fastapi import FastAPI, HTTPException
from google.protobuf import wrappers_pb2

from dapr_agents.agents.configs import (
    AgentExecutionConfig,
    AgentMCPConfig,
    AgentPubSubConfig,
    AgentRegistryConfig,
    AgentStateConfig,
    WorkflowGrpcOptions,
    WorkflowRetryPolicy,
)
from dapr_agents.storage.daprstores.stateservice import StateStoreService
from dapr_agents.workflow.runners import AgentRunner

from src.agent import BrowserUseDurableAgent
from src.config import (
    AGENT_BROADCAST_TOPIC,
    AGENT_MEMORY_KEY_PREFIX,
    AGENT_PUBSUB_NAME,
    AGENT_REGISTRY_STORE,
    AGENT_REGISTRY_TEAM,
    AGENT_SERVICE_NAME,
    AGENT_STATE_KEY_PREFIX,
    AGENT_STATE_STORE,
    AGENT_TOPIC,
    BROWSER_CDP_URL,
    DEFAULT_MAX_STEPS,
    WORKFLOW_GRPC_MAX_MESSAGE_BYTES,
)
from src.event_publisher import publish_session_event, set_incremental_tier_enabled
from src.executor import BrowserUseExecutor, _session_cancel_state_key
from src.session_config import (
    TERMINAL_CONTROL_EVENT_TYPES,
    external_control_event_as_user_event,
)

# browser-use posthog telemetry: off by default in-cluster (no phone-home,
# no shutdown-flush hazards inside durable activities). Explicit env wins.
os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(AGENT_SERVICE_NAME)

# Registry descriptor declares incrementalEvents: true for this runtime; the
# tier's runtime-internal enrichments (audit fields, context telemetry) are
# fail-soft when their modules aren't shipped.
set_incremental_tier_enabled(True)

# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------

state_config = AgentStateConfig(
    store=StateStoreService(store_name=AGENT_STATE_STORE),
)

pubsub_config = AgentPubSubConfig(
    pubsub_name=AGENT_PUBSUB_NAME,
    agent_topic=AGENT_TOPIC,
    broadcast_topic=AGENT_BROADCAST_TOPIC,
)

registry_config = AgentRegistryConfig(
    store=StateStoreService(store_name=AGENT_REGISTRY_STORE),
    team_name=AGENT_REGISTRY_TEAM,
)

agent = BrowserUseDurableAgent(
    name=AGENT_SERVICE_NAME,
    role="Durable Browser Automation Agent",
    goal=(
        "Complete interactive browser tasks (navigate, click, type, extract) "
        "against the attached Chromium over CDP"
    ),
    executor=BrowserUseExecutor(),
    execution=AgentExecutionConfig(max_iterations=DEFAULT_MAX_STEPS),
    state=state_config,
    pubsub=pubsub_config,
    registry=registry_config,
    # browser-use owns its tools; skip dapr-agents MCPServer auto-discovery.
    mcp=AgentMCPConfig(enabled=False),
    workflow_grpc=WorkflowGrpcOptions(
        max_send_message_length=WORKFLOW_GRPC_MAX_MESSAGE_BYTES,
        max_receive_message_length=WORKFLOW_GRPC_MAX_MESSAGE_BYTES,
    ),
    # Same widened retry window as dapr-agent-py (~140s across 8 attempts):
    # covers pod restart + image pull + sidecar handshake.
    retry_policy=WorkflowRetryPolicy(
        max_attempts=8,
        initial_backoff_seconds=4,
        max_backoff_seconds=45,
        backoff_multiplier=1.5,
    ),
    agent_metadata={
        "service": AGENT_SERVICE_NAME,
        "framework": "browser-use",
        "stateStore": AGENT_STATE_STORE,
        "stateKeyPrefix": AGENT_STATE_KEY_PREFIX,
        "memoryKeyPrefix": AGENT_MEMORY_KEY_PREFIX,
        "cdpUrl": BROWSER_CDP_URL,
        "instancesEndpoint": "/agent/instances",
        "pubsub": AGENT_PUBSUB_NAME,
        "agentTopic": AGENT_TOPIC,
        "broadcastTopic": AGENT_BROADCAST_TOPIC,
    },
)

runner = AgentRunner()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("%s starting (cdp=%s)", AGENT_SERVICE_NAME, BROWSER_CDP_URL)
    yield
    logger.info("%s shutting down", AGENT_SERVICE_NAME)
    runner.shutdown(agent)


app = FastAPI(
    title=AGENT_SERVICE_NAME,
    description="Durable browser-use agent (Dapr Agents executor seam)",
    version="0.1.0",
    lifespan=lifespan,
)

# Wires pub/sub routes + HTTP endpoints; with app= it does not start uvicorn.
runner.serve(agent, app=app, port=8002)


# ---------------------------------------------------------------------------
# Dapr sidecar helpers
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
        f"{sidecar}/v1.0/workflows/dapr/{encoded}/{action}",
        data=b"",
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status, ""
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")[:300]


# ---------------------------------------------------------------------------
# Platform endpoints (mirror dapr-agent-py's bridge + lifecycle surface)
# ---------------------------------------------------------------------------


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "service": AGENT_SERVICE_NAME}


@app.get("/readyz")
def readyz() -> dict:
    return {"ok": True, "service": AGENT_SERVICE_NAME}


@app.post("/internal/sessions/spawn")
def spawn_session_endpoint(request: dict) -> dict:
    """Start a session_workflow instance on this sidecar.

    The BFF can't invoke the Dapr workflow HTTP API cross-app via placement,
    so it service-invokes this endpoint and the call runs on this app's own
    sidecar, which owns session_workflow.

    Body: { instanceId: str, payload: dict }
    """
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

    Body: { instanceId: str, eventName: str, payload: dict }
    """
    import dapr.ext.workflow._durabletask.internal.protos as pb

    instance_id = str(request.get("instanceId") or "").strip()
    event_name = str(request.get("eventName") or "").strip()
    payload = request.get("payload") or {}
    if not instance_id or not event_name:
        raise HTTPException(status_code=400, detail="instanceId + eventName required")
    if event_name in TERMINAL_CONTROL_EVENT_TYPES:
        # Persist before raising so the executor's between-step cancellation
        # check halts an in-flight browser turn (the workflow can't observe
        # external events mid-activity).
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
