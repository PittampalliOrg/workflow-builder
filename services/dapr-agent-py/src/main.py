"""Minimal Python durable agent with hot-reload configuration."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

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


@app.get("/healthz")
async def health_check() -> dict:
    return {"status": "healthy", "service": "dapr-agent-py"}


@app.get("/readyz")
async def readiness_check() -> dict:
    return {"status": "ready", "service": "dapr-agent-py"}
