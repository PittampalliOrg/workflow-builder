"""Minimal Dapr durable-agent runtime for SWE-bench isolation canaries.

This entrypoint intentionally keeps the workflow shape small:

session_workflow -> Dapr Agents agent_workflow -> call_llm/run_tool activities

It reuses the existing OpenShell tools and provider adapters, but avoids the
featureful dapr-agent-py session implementation: no per-turn child workflow,
no event-log publishing, no memory summarization, no hooks/plugins, no peer
agent fan-out, and no MLflow finalization path. The goal is to isolate whether
our custom agent/session construction contributes to benchmark stalls or
workflow nondeterminism.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException


def _configure_durabletask_grpc_defaults() -> None:
    """Raise durabletask's worker channel limit before any workflow runtime starts."""
    try:
        import dapr.ext.workflow._durabletask.internal.shared as durabletask_shared
    except Exception:
        return
    try:
        max_message_bytes = max(
            1,
            int(os.environ.get("DAPR_WORKFLOW_GRPC_MAX_MESSAGE_BYTES", "16777216")),
        )
    except ValueError:
        max_message_bytes = 16 * 1024 * 1024
    existing = getattr(durabletask_shared, "DEFAULT_GRPC_KEEPALIVE_OPTIONS", ())
    merged = {
        str(key): value
        for key, value in existing
        if isinstance(key, str) and key
    }
    merged.setdefault("grpc.max_receive_message_length", max_message_bytes)
    merged.setdefault("grpc.max_send_message_length", max_message_bytes)
    durabletask_shared.DEFAULT_GRPC_KEEPALIVE_OPTIONS = tuple(merged.items())


_configure_durabletask_grpc_defaults()

from src.benchmark_context import is_swebench_execution_context
from src.dependency_guard import assert_dapr_agents_version
from src.openshell_runtime import DEFAULT_CWD, bind_runtime, reset_runtime
from src.telemetry import init_telemetry, is_telemetry_ready, shutdown_telemetry
from src.tools import all_tools, bootstrap_mcp_tools

assert_dapr_agents_version()

from dapr_agents.agents.configs import (  # noqa: E402
    AgentExecutionConfig,
    AgentStateConfig,
    ToolExecutionMode,
    WorkflowRetryPolicy,
)
from dapr_agents.agents.durable import DurableAgent  # noqa: E402
from dapr_agents.llm.dapr import DaprChatClient  # noqa: E402
from dapr_agents.storage.daprstores.stateservice import StateStoreService  # noqa: E402
from dapr_agents.workflow.decorators import workflow_entry  # noqa: E402
from dapr_agents.workflow.runners import AgentRunner  # noqa: E402

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

_otel_ready = init_telemetry()


def _env_bool(name: str) -> bool | None:
    raw = os.environ.get(name)
    if raw is None:
        return None
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return None


def _dapr_api_token_headers() -> dict[str, str]:
    token = os.environ.get("DAPR_API_TOKEN", "").strip()
    return {"dapr-api-token": token} if token else {}


def _dapr_http_sidecar_url() -> str:
    endpoint = os.environ.get("DAPR_HTTP_ENDPOINT", "").strip()
    if endpoint:
        return endpoint.rstrip("/")
    return (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )


def _agent_readyz_require_workflow_workers() -> bool:
    return _env_bool("DAPR_AGENT_READYZ_REQUIRE_WORKFLOW_WORKERS") is not False


def _agent_readyz_timeout_seconds() -> float:
    try:
        return max(
            0.5,
            float(os.environ.get("DAPR_AGENT_READYZ_TIMEOUT_SECONDS", "2")),
        )
    except ValueError:
        return 2.0


def _agent_workflow_runtime_status() -> tuple[bool, dict[str, Any]]:
    details: dict[str, Any] = {
        "daprHttpUrl": _dapr_http_sidecar_url(),
        "requireWorkflowWorkers": _agent_readyz_require_workflow_workers(),
    }
    if not details["requireWorkflowWorkers"]:
        return True, details
    request = urllib.request.Request(
        f"{_dapr_http_sidecar_url()}/v1.0/metadata",
        headers=_dapr_api_token_headers(),
        method="GET",
    )
    try:
        with urllib.request.urlopen(
            request,
            timeout=_agent_readyz_timeout_seconds(),
        ) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        details["metadataError"] = (
            f"HTTP {exc.code}: "
            f"{exc.read().decode('utf-8', errors='replace')[:300]}"
        )
        return False, details
    except Exception as exc:  # noqa: BLE001
        details["metadataError"] = str(exc)
        return False, details
    try:
        payload = json.loads(raw.decode("utf-8")) if raw else {}
    except Exception as exc:  # noqa: BLE001
        details["metadataError"] = f"invalid metadata JSON: {exc}"
        return False, details
    if not isinstance(payload, dict):
        details["metadataError"] = "metadata response was not an object"
        return False, details
    workflows = (
        payload.get("workflows") if isinstance(payload.get("workflows"), dict) else {}
    )
    scheduler = (
        payload.get("scheduler") if isinstance(payload.get("scheduler"), dict) else {}
    )
    try:
        connected_workers = int(workflows.get("connectedWorkers") or 0)
    except (TypeError, ValueError):
        connected_workers = 0
    connected_schedulers = scheduler.get("connected_addresses")
    details.update(
        {
            "appId": payload.get("id"),
            "runtimeVersion": payload.get("runtimeVersion"),
            "workflowConnectedWorkers": connected_workers,
            "schedulerConnectedAddresses": (
                connected_schedulers if isinstance(connected_schedulers, list) else []
            ),
        }
    )
    if connected_workers < 1:
        details["error"] = "workflow runtime has no connected Dapr workflow workers"
        return False, details
    return True, details


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name)
    try:
        value = default if raw is None else int(raw)
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


def _clean_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _first_text_block(event: dict[str, Any]) -> str | None:
    content = event.get("content")
    if isinstance(content, str):
        return _clean_string(content)
    if not isinstance(content, list):
        return None
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if isinstance(text, str) and text:
            parts.append(text)
    return _clean_string("\n".join(parts))


def _extract_task(message: dict[str, Any]) -> str:
    task = _clean_string(message.get("task"))
    if task:
        return task

    user = message.get("user")
    if isinstance(user, dict):
        prompt = _clean_string(user.get("prompt"))
        if prompt:
            return prompt

    for event in message.get("initialEvents") or []:
        if not isinstance(event, dict):
            continue
        event_type = str(event.get("type") or "")
        if event_type != "user.message":
            continue
        prompt = _first_text_block(event)
        if prompt:
            return prompt

    rendered = message.get("rendered")
    if isinstance(rendered, dict):
        prompt = _clean_string(rendered.get("user"))
        if prompt:
            return prompt

    return ""


def _runtime_context_from_message(message: dict[str, Any]) -> dict[str, Any]:
    metadata = message.get("_message_metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    return {
        "sandboxName": _clean_string(message.get("sandboxName"))
        or _clean_string(metadata.get("sandboxName")),
        "cwd": _clean_string(message.get("cwd"))
        or _clean_string(metadata.get("cwd"))
        or DEFAULT_CWD,
        "sessionId": _clean_string(message.get("sessionId"))
        or _clean_string(metadata.get("agentRunId"))
        or _clean_string(metadata.get("mlflowSessionId")),
        "workflowExecutionId": _clean_string(message.get("workflowExecutionId"))
        or _clean_string(metadata.get("workflowExecutionId")),
    }


def _max_iterations_from_message(message: dict[str, Any], default: int) -> int:
    candidates = [
        message.get("maxIterations"),
        message.get("maxTurns"),
    ]
    agent_config = message.get("agentConfig")
    if isinstance(agent_config, dict):
        candidates.append(agent_config.get("maxTurns"))
        candidates.append(agent_config.get("maxIterations"))
    for candidate in candidates:
        try:
            parsed = int(candidate)
        except (TypeError, ValueError):
            continue
        if parsed > 0:
            return max(1, min(parsed, 250))
    return default


def _patch_provider_adapters(agent: DurableAgent) -> None:
    for module_name, function_name, label in [
        ("src.anthropic_adapter", "patch_for_anthropic", "Anthropic"),
        ("src.openai_adapter", "patch_for_openai", "OpenAI"),
        ("src.nvidia_adapter", "patch_for_nvidia", "NVIDIA"),
        ("src.foundry_adapter", "patch_for_foundry", "Azure AI Foundry"),
        ("src.together_adapter", "patch_for_together", "Together AI"),
        ("src.deepseek_adapter", "patch_for_deepseek", "DeepSeek"),
        ("src.alibaba_adapter", "patch_for_alibaba", "Alibaba"),
        ("src.kimi_adapter", "patch_for_kimi", "Kimi"),
        ("src.gateway_adapter", "patch_for_gateway", "Gateway"),
    ]:
        try:
            module = __import__(module_name, fromlist=[function_name])
            getattr(module, function_name)(agent.llm)
        except Exception as exc:  # noqa: BLE001
            logger.warning("%s adapter patch failed: %s", label, exc)


class MinimalOpenShellDurableAgent(DurableAgent):
    """Dapr Agents runtime with only OpenShell binding glue added."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._runtime_context_by_instance: dict[str, dict[str, Any]] = {}
        self._default_max_iterations = self.execution.max_iterations

    def _context_for_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        instance_id = str(payload.get("instance_id") or "")
        return self._runtime_context_by_instance.get(instance_id, {})

    def _with_runtime_context(self, payload: dict[str, Any]):
        context = self._context_for_payload(payload)
        runtime, token = bind_runtime(
            sandbox_name=context.get("sandboxName"),
            cwd=context.get("cwd") or DEFAULT_CWD,
            session_id=context.get("sessionId"),
        )
        return runtime, token

    def call_llm(self, ctx, payload):  # noqa: ANN001
        runtime, token = self._with_runtime_context(payload)
        try:
            logger.info(
                "[minimal-agent] call_llm instance=%s sandbox=%s cwd=%s",
                payload.get("instance_id"),
                runtime.configured_sandbox_name,
                runtime.cwd,
            )
            return super().call_llm(ctx, payload)
        finally:
            reset_runtime(token)

    def run_tool(self, ctx, payload):  # noqa: ANN001
        runtime, token = self._with_runtime_context(payload)
        try:
            logger.info(
                "[minimal-agent] run_tool instance=%s sandbox=%s cwd=%s",
                payload.get("instance_id"),
                runtime.configured_sandbox_name,
                runtime.cwd,
            )
            return super().run_tool(ctx, payload)
        finally:
            reset_runtime(token)

    @workflow_entry
    def agent_workflow(self, ctx, message: dict):  # noqa: ANN001
        context = _runtime_context_from_message(message)
        self._runtime_context_by_instance[ctx.instance_id] = context
        self.execution.max_iterations = _max_iterations_from_message(
            message,
            self._default_max_iterations,
        )
        try:
            return (yield from super().agent_workflow(ctx, message))
        finally:
            self.execution.max_iterations = self._default_max_iterations

    def session_workflow(self, ctx, message: dict):  # noqa: ANN001
        if not isinstance(message, dict):
            message = {}
        session_id = str(message.get("sessionId") or ctx.instance_id)
        task = _extract_task(message)
        if not task:
            raise RuntimeError("minimal session_workflow requires a user prompt/task")

        context = _runtime_context_from_message({**message, "sessionId": session_id})
        child_instance_id = f"{ctx.instance_id}::agent"
        child_input = {
            **message,
            "task": task,
            "sessionId": session_id,
            "context": context,
            "_message_metadata": {
                **(
                    message.get("_message_metadata")
                    if isinstance(message.get("_message_metadata"), dict)
                    else {}
                ),
                "agentRunId": session_id,
                "source": "minimal-durable-agent",
            },
        }
        logger.info(
            "[minimal-agent] session_workflow start session=%s child=%s sandbox=%s swebench=%s",
            session_id,
            child_instance_id,
            context.get("sandboxName"),
            is_swebench_execution_context(ctx.instance_id, context),
        )
        result = yield ctx.call_child_workflow(
            self.agent_workflow_name,
            input=child_input,
            instance_id=child_instance_id,
            retry_policy=self._retry_policy,
        )
        if isinstance(result, dict):
            result.setdefault("success", True)
            result.setdefault("sessionId", session_id)
            return result
        return {"success": True, "sessionId": session_id, "content": str(result)}

    def register_workflows(self, runtime) -> None:  # noqa: ANN001
        super().register_workflows(runtime)
        runtime.register_workflow(self.session_workflow)


AGENT_SERVICE_NAME = os.environ.get("AGENT_SERVICE_NAME", "dapr-agent-py-minimal")
DEFAULT_LLM_COMPONENT = os.environ.get(
    "DAPR_LLM_COMPONENT_DEFAULT",
    os.environ.get("AGENT_LLM_COMPONENT", "llm-deepseek-v4-pro"),
)
DEFAULT_MAX_ITERATIONS = _env_int(
    "DAPR_AGENT_PY_MAX_ITERATIONS",
    50,
    minimum=1,
    maximum=250,
)
AGENT_STATE_STORE = os.environ.get("AGENT_STATE_STORE", "dapr-agent-py-statestore")

agent = MinimalOpenShellDurableAgent(
    name=AGENT_SERVICE_NAME,
    role="Minimal OpenShell Durable Coding Agent",
    goal="Solve software-engineering tasks inside an OpenShell sandbox",
    system_prompt=(
        "You are solving a software-engineering task inside /sandbox/repo. "
        "Use tools to inspect and edit the repository. Keep the final patch applied."
    ),
    llm=DaprChatClient(component_name=DEFAULT_LLM_COMPONENT),
    tools=all_tools,
    execution=AgentExecutionConfig(
        max_iterations=DEFAULT_MAX_ITERATIONS,
        tool_execution_mode=ToolExecutionMode.SEQUENTIAL,
    ),
    state=AgentStateConfig(store=StateStoreService(store_name=AGENT_STATE_STORE)),
    retry_policy=WorkflowRetryPolicy(
        max_attempts=8,
        initial_backoff_seconds=4,
        max_backoff_seconds=45,
        backoff_multiplier=1.5,
    ),
    agent_metadata={
        "service": AGENT_SERVICE_NAME,
        "stateStore": AGENT_STATE_STORE,
        "mode": "minimal-durable-agent-canary",
    },
)
_patch_provider_adapters(agent)

runner = AgentRunner()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info("%s starting", AGENT_SERVICE_NAME)
    try:
        added = await bootstrap_mcp_tools(agent)
        if added:
            logger.info("[minimal-agent] added %d bootstrap MCP tool(s)", added)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[minimal-agent] MCP bootstrap failed: %s", exc)
    yield
    logger.info("%s shutting down", AGENT_SERVICE_NAME)
    runner.shutdown(agent)
    shutdown_telemetry()


app = FastAPI(
    title=AGENT_SERVICE_NAME,
    description="Minimal Dapr durable-agent canary runtime",
    version="0.1.0",
    lifespan=lifespan,
)
runner.serve(agent, app=app, port=8002)

if _otel_ready and is_telemetry_ready():
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app, excluded_urls="healthz,readyz")
    except Exception as exc:  # noqa: BLE001
        logger.warning("FastAPI OTEL instrumentation failed: %s", exc)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "runtime": "minimal-durable-agent"}


@app.get("/readyz")
def readyz() -> dict[str, Any]:
    ready, runtime_status = _agent_workflow_runtime_status()
    if not ready:
        raise HTTPException(
            status_code=503,
            detail={
                "status": "not_ready",
                "service": AGENT_SERVICE_NAME,
                "code": "workflow_runtime_unavailable",
                "runtimeStatus": runtime_status,
            },
        )
    return {
        "status": "ready",
        "runtime": "minimal-durable-agent",
        "agent": AGENT_SERVICE_NAME,
        "llmComponent": DEFAULT_LLM_COMPONENT,
        "runtimeStatus": runtime_status,
    }
