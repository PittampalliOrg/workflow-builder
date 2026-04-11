"""Minimal Python durable agent with hot-reload configuration."""

from __future__ import annotations

import logging
import json
import os
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

# ---------------------------------------------------------------------------
# OpenTelemetry initialization (must happen before FastAPI app creation)
# ---------------------------------------------------------------------------

_otel_ready = False


def _init_otel() -> None:
    global _otel_ready
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        logging.getLogger(__name__).info(
            "OTEL_EXPORTER_OTLP_ENDPOINT not set, skipping tracing"
        )
        return
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        resource = Resource.create(
            {
                "service.name": os.environ.get("OTEL_SERVICE_NAME", "dapr-agent-py"),
                "service.namespace": "workflow-builder",
                "openinference.project.name": "workflow-builder",
            }
        )
        provider = TracerProvider(resource=resource)
        provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces"))
        )
        trace.set_tracer_provider(provider)

        try:
            from dapr_agents.observability import DaprAgentsInstrumentor

            DaprAgentsInstrumentor().instrument(tracer_provider=provider)
            logging.getLogger(__name__).info("DaprAgentsInstrumentor enabled")
        except Exception as exc:
            logging.getLogger(__name__).warning(
                "DaprAgentsInstrumentor failed: %s", exc
            )

        _otel_ready = True
        logging.getLogger(__name__).info(
            "OpenTelemetry tracing initialized -> %s", endpoint
        )
    except Exception as exc:
        logging.getLogger(__name__).warning("OpenTelemetry init failed: %s", exc)


_init_otel()

# ---------------------------------------------------------------------------
# Agent setup (imported after OTEL so spans are captured)
# ---------------------------------------------------------------------------

from dapr_agents.agents.configs import (
    AgentPubSubConfig,
    AgentRegistryConfig,
    AgentStateConfig,
    RuntimeConfigKey,
    RuntimeSubscriptionConfig,
)
from dapr_agents.agents.durable import DurableAgent
from dapr_agents.storage.daprstores.stateservice import StateStoreService
from dapr_agents.workflow.runners import AgentRunner

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Hot-reload configuration subscription
# ---------------------------------------------------------------------------


def on_config_change(key: str, value):
    logger.info("[hot-reload] %s = %s", key, value)


config = RuntimeSubscriptionConfig(
    store_name="runtime-config",
    keys=[
        RuntimeConfigKey.AGENT_ROLE,
        RuntimeConfigKey.AGENT_GOAL,
        RuntimeConfigKey.AGENT_INSTRUCTIONS,
        RuntimeConfigKey.AGENT_STYLE_GUIDELINES,
        RuntimeConfigKey.MAX_ITERATIONS,
    ],
    on_config_change=on_config_change,
)

# ---------------------------------------------------------------------------
# Infrastructure configs
# ---------------------------------------------------------------------------

state_config = AgentStateConfig(
    store=StateStoreService(store_name="dapr-agent-py-statestore")
)

pubsub_config = AgentPubSubConfig(
    pubsub_name="pubsub",
    agent_topic="dapr-agent-py.requests",
    broadcast_topic="dapr-agent-py.broadcast",
)

registry_config = AgentRegistryConfig(
    store=StateStoreService(
        store_name=os.environ.get("AGENT_REGISTRY_STORE", "agent-registry")
    ),
    team_name=os.environ.get("AGENT_REGISTRY_TEAM", "default"),
)

# ---------------------------------------------------------------------------
# Agent instance
# ---------------------------------------------------------------------------

agent = DurableAgent(
    name="dapr-agent-py",
    role="General Assistant",
    goal="Help users with tasks using available tools and knowledge",
    instructions=["Think step by step", "Be concise and helpful"],
    style_guidelines=["Be professional and direct"],
    configuration=config,
    state=state_config,
    pubsub=pubsub_config,
    registry=registry_config,
    agent_metadata={
        "service": "dapr-agent-py",
        "stateStore": "dapr-agent-py-statestore",
        "stateSchema": "dapr-agents-durable-default",
        "stateKeyPrefix": "dapr-agent-py:_workflow",
        "memoryKeyPrefix": "dapr-agent-py:_memory",
        "instancesEndpoint": "/agent/instances",
        "pubsub": "pubsub",
        "agentTopic": "dapr-agent-py.requests",
        "broadcastTopic": "dapr-agent-py.broadcast",
    },
)

# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

runner = AgentRunner()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("dapr-agent-py starting")
    yield
    logger.info("dapr-agent-py shutting down")
    runner.shutdown(agent)


app = FastAPI(
    title="dapr-agent-py",
    description="Minimal Python durable agent with hot-reload",
    version="0.1.0",
    lifespan=lifespan,
)

# Wire agent pub/sub routes and HTTP endpoints onto the FastAPI app.
# When app= is provided, serve() returns the app without starting uvicorn.
runner.serve(agent, app=app, port=8002)

# Instrument FastAPI with OTEL
if _otel_ready:
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app, excluded_urls="healthz,readyz")
        logger.info("FastAPI OTEL instrumentation applied")
    except Exception as exc:
        logger.warning("FastAPI OTEL instrumentation failed: %s", exc)


def _parse_json(value: Any) -> Any:
    parsed = value
    while isinstance(parsed, str):
        text = parsed.strip()
        if not text:
            return parsed
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return parsed
    return parsed


def _terminal_status(status: str) -> bool:
    return status in {"COMPLETED", "FAILED", "CANCELED", "TERMINATED"}


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


def _list_instance_ids(page_size: int) -> list[str]:
    import durabletask.internal.orchestrator_service_pb2 as pb

    ids: list[str] = []
    continuation_token = ""
    while len(ids) < page_size:
        request = pb.ListInstanceIDsRequest(pageSize=min(200, page_size - len(ids)))
        if continuation_token:
            request.continuationToken = continuation_token
        response = _taskhub_call("ListInstanceIDs", request)
        ids.extend([str(item) for item in response.instanceIds])
        continuation_token = str(response.continuationToken or "")
        if not continuation_token:
            break
    return ids


def _runtime_status_name(value: Any) -> str:
    import durabletask.internal.orchestrator_service_pb2 as pb

    try:
        return pb.OrchestrationStatus.Name(value).replace("ORCHESTRATION_STATUS_", "")
    except Exception:
        return str(value or "UNKNOWN").replace("ORCHESTRATION_STATUS_", "")


def _timestamp_iso(value: Any) -> str | None:
    if value is None:
        return None
    try:
        seconds = int(getattr(value, "seconds", 0) or 0)
        nanos = int(getattr(value, "nanos", 0) or 0)
        if seconds == 0 and nanos == 0:
            return None
        return value.ToDatetime().isoformat()
    except Exception:
        return None


def _wrapped_string(value: Any) -> str | None:
    text = getattr(value, "value", None)
    return text if isinstance(text, str) and text else None


def _read_agent_state_key(key: str) -> Any:
    store_name = "dapr-agent-py-statestore"
    encoded_key = urllib.parse.quote(key, safe="")
    sidecar = (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )
    url = (
        f"{sidecar}/v1.0/state/{urllib.parse.quote(store_name, safe='')}/{encoded_key}"
        f"?metadata.partitionKey={encoded_key}"
    )
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            raw = response.read().decode("utf-8")
    except Exception:
        return None
    return _parse_json(raw)


def _build_instance_payload(instance_id: str) -> dict[str, Any] | None:
    import durabletask.internal.orchestrator_service_pb2 as pb

    response = _taskhub_call(
        "GetInstance",
        pb.GetInstanceRequest(instanceId=instance_id, getInputsAndOutputs=True),
    )
    if not getattr(response, "exists", False):
        return None

    state = response.orchestrationState
    runtime_status = _runtime_status_name(getattr(state, "orchestrationStatus", None))
    started_at = _timestamp_iso(getattr(state, "createdTimestamp", None))
    last_updated_at = _timestamp_iso(getattr(state, "lastUpdatedTimestamp", None))
    completed_at = _timestamp_iso(getattr(state, "completedTimestamp", None))
    input_payload = _parse_json(_wrapped_string(getattr(state, "input", None)))
    output_payload = _parse_json(_wrapped_string(getattr(state, "output", None)))
    workflow_state_key = f"dapr-agent-py:_workflow_{instance_id}".lower()
    memory_key = f"dapr-agent-py:_memory_{instance_id}".lower()
    workflow_state = _read_agent_state_key(workflow_state_key)
    memory_state = _read_agent_state_key(memory_key)
    workflow_record = workflow_state if isinstance(workflow_state, dict) else {}
    input_record = input_payload if isinstance(input_payload, dict) else {}

    return {
        "input_value": input_record.get("task") or input_record.get("prompt") or "",
        "output": (
            json.dumps(output_payload)
            if isinstance(output_payload, dict)
            else output_payload
        ),
        "start_time": started_at or "",
        "end_time": completed_at
        or (last_updated_at if _terminal_status(runtime_status) else None),
        "status": runtime_status.lower(),
        "messages": workflow_record.get("messages") or [],
        "tool_history": workflow_record.get("tool_history") or [],
        "workflow_instance_id": instance_id,
        "session_id": input_record.get("sessionId") or input_record.get("session_id"),
        "source": workflow_record.get("source") or "dapr-agents-default-state",
        "workflow_name": "dapr-agent-py",
        "error": workflow_record.get("error"),
        "state_key": workflow_state_key,
        "memory_key": memory_key,
        "memory": memory_state,
    }


@app.get("/agent/instances")
async def list_agent_instances(limit: int = 100) -> dict[str, Any]:
    normalized_limit = max(1, min(int(limit), 500))
    instances: dict[str, Any] = {}
    for instance_id in _list_instance_ids(normalized_limit):
        payload = _build_instance_payload(instance_id)
        if payload is not None:
            instances[instance_id] = payload
    return {
        "source": "dapr-agents-default-state",
        "storeName": "dapr-agent-py-statestore",
        "agentName": "dapr-agent-py",
        "stateKey": "dapr-agent-py:_workflow_<instance_id>",
        "memoryKey": "dapr-agent-py:_memory_<instance_id>",
        "found": True,
        "instances": instances,
    }


@app.get("/healthz")
async def health_check() -> dict:
    return {"status": "healthy", "service": "dapr-agent-py"}


@app.get("/readyz")
async def readiness_check() -> dict:
    return {"status": "ready", "service": "dapr-agent-py"}
