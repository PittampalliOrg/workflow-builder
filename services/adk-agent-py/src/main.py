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

import logging  # noqa: E402
from contextlib import asynccontextmanager  # noqa: E402

from fastapi import FastAPI  # noqa: E402

from google.adk.agents import LlmAgent  # noqa: E402

from src.adapters.gemini_thought_signatures import (  # noqa: E402
    install_gemini_thought_signature_patch,
)
from src.adapters.gemini_model import build_default_model  # noqa: E402
from src.adapters.mcp_translation import build_mcp_toolsets  # noqa: E402
from src.runner.compose import build_runner, register_session_workflow  # noqa: E402
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
