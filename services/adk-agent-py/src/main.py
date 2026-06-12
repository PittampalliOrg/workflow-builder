"""FastAPI entrypoint for adk-agent-py.

Pod boot sequence:

1. `init_telemetry()` — must run FIRST so MCP / Diagrid / ADK imports are
   instrumented from their first call (mirrors dapr-agent-py:59).
2. Construct the ADK `LlmAgent` with all 18 native FunctionTools + any MCP
   toolsets discovered from the bootstrap env JSON.
3. `build_runner(agent)` instantiates Diagrid's `DaprWorkflowAgentRunner` —
   this internally creates the `WorkflowRuntime` and registers Diagrid's
   `agent_workflow` plus its `call_llm_activity` / `execute_tool_activity`.
4. `register_session_workflow(runner)` attaches OUR outer `session_workflow`
   to the same `WorkflowRuntime` so `ctx.call_child_workflow("session_workflow",
   ...)` from the orchestrator routes here.
5. FastAPI lifespan: `runner.start()` on app startup, `runner.shutdown()` on
   teardown.

The pod doesn't expose any application HTTP routes — it only needs the
FastAPI app object so `uvicorn` runs; daprd communicates with the
WorkflowRuntime via the Dapr workflow gRPC protocol.
"""

from __future__ import annotations

# --- OTEL bootstrap MUST be first import work --------------------------------
# Mirrors `services/dapr-agent-py/src/main.py:59` — the providers module
# attaches the inbound trace context from `WORKFLOW_BUILDER_TRACEPARENT` env,
# wires MLflow as a secondary span destination, and installs the OTLP
# exporters. Subsequent imports (Diagrid, ADK, MCP) emit spans against this
# provider automatically.
from src.telemetry import init_telemetry

init_telemetry()

import json  # noqa: E402
import logging  # noqa: E402
import os  # noqa: E402
from contextlib import asynccontextmanager  # noqa: E402
from typing import Any  # noqa: E402

from fastapi import FastAPI, HTTPException  # noqa: E402
from google.protobuf import wrappers_pb2  # noqa: E402

from google.adk.agents import LlmAgent  # noqa: E402

from src.telemetry.diagrid_adk import install_diagrid_adk_telemetry_patch  # noqa: E402

install_diagrid_adk_telemetry_patch()

from src.adapters.gemini_thought_signatures import (  # noqa: E402
    install_gemini_thought_signature_patch,
)
from src.adapters.gemini_model import build_default_model  # noqa: E402
from src.adapters.mcp_translation import build_mcp_toolsets  # noqa: E402
from src.runner.compose import build_runner, register_session_workflow  # noqa: E402
from src.runtime_config import get_runtime_config_snapshot  # noqa: E402
from src.session_config import external_control_event_as_user_event  # noqa: E402
from src.tools import all_adk_tools  # noqa: E402

logger = logging.getLogger(__name__)
install_gemini_thought_signature_patch()


def _build_agent() -> LlmAgent:
    """Construct the ADK LlmAgent with all tools attached.

    `instruction` is a placeholder — Diagrid's `call_llm_activity` reads
    `system_instruction` from `AgentWorkflowInput.agent_config` each turn,
    which our `session_workflow` rebuilds from the BFF-rendered
    `instructionBundle.rendered.system`. The placeholder here is only used
    at LlmAgent metadata introspection time.
    """
    mcp_toolsets = build_mcp_toolsets()
    if mcp_toolsets:
        logger.info(
            "[agent-build] attaching %d MCP toolset(s) to LlmAgent.tools",
            len(mcp_toolsets),
        )
    return LlmAgent(
        name="adk_agent_py",
        model=build_default_model(),
        instruction=(
            "Placeholder system instruction — overridden per turn by "
            "session_workflow via AgentWorkflowInput.agent_config.system_instruction."
        ),
        tools=[*all_adk_tools, *mcp_toolsets],
    )


# Module-level so `uvicorn src.main:app` finds the FastAPI app.
_agent = _build_agent()
_runner = build_runner(_agent)
register_session_workflow(_runner, declared_tools=list(_agent.tools or []))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info("[adk-agent-py] starting Dapr workflow runtime")
    _runner.start()
    try:
        yield
    finally:
        logger.info("[adk-agent-py] shutting down Dapr workflow runtime")
        _runner.shutdown()


app = FastAPI(title="adk-agent-py", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "runtime": "adk-agent-py"}


@app.get("/readyz")
def readyz() -> dict[str, object]:
    return {"status": "ok", "running": _runner.is_running}


@app.get("/internal/runtime/instances/{instance_id}/config")
def get_runtime_config_endpoint(instance_id: str) -> dict[str, Any]:
    event = get_runtime_config_snapshot(instance_id)
    if not event:
        raise HTTPException(status_code=404, detail="Runtime config not found")
    return event


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
    """Start this runtime's session_workflow for a UI/direct session."""
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
    """Raise a user/control event into this runtime's session_workflow."""
    import dapr.ext.workflow._durabletask.internal.protos as pb

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
