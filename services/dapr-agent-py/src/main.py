"""Minimal Python durable agent with hot-reload configuration."""

from __future__ import annotations

import logging
import asyncio
import json
import os
import re
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

from src.tools import all_tools
from src.tools.skill_tool import get_registry as get_skill_registry, load_skills_from_dir
from src.tools.skill_tool.models import SkillDefinition
from src.tools.skill_tool.prompt import format_skill_listings
from src.openshell_runtime import DEFAULT_CWD, get_runtime
from src.event_publisher import (
    publish_event,
    publish_workflow_started,
    publish_workflow_completed,
    publish_tool_start,
    publish_tool_complete,
    publish_llm_start,
    publish_llm_complete,
)

from dapr_agents.agents.configs import (
    AgentExecutionConfig,
    AgentPubSubConfig,
    AgentRegistryConfig,
    AgentStateConfig,
    RuntimeConfigKey,
    RuntimeSubscriptionConfig,
)
from dapr_agents.agents.schemas import TriggerAction
from dapr_agents.agents.durable import DurableAgent
from dapr_agents.llm.dapr import DaprChatClient
from dapr_agents.storage.daprstores.stateservice import StateStoreService
from dapr_agents.tool.mcp import MCPClient
from dapr_agents.tool.utils.serialization import serialize_tool_result
from dapr_agents.types import ToolMessage
from dapr_agents.workflow.decorators import message_router, workflow_entry
from dapr_agents.workflow.runners import AgentRunner

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

DEFAULT_MAX_ITERATIONS = int(os.environ.get("DAPR_AGENT_PY_MAX_ITERATIONS", "120"))

def _build_system_prompt(cwd: str, sandbox_name: str | None = None) -> str:
    """Build the system prompt with a structured <env> block.

    Mirrors the pattern from claude-code-src/main/constants/prompts.ts
    (computeSimpleEnvInfo) where the working directory is communicated
    in a structured <env> section of the system prompt.
    """
    env_lines = [f"Working directory: {cwd}"]
    if sandbox_name:
        env_lines.append(f"OpenShell sandbox: {sandbox_name}")
    env_block = "\n".join(env_lines)

    return f"""You are dapr-agent-py, a Dapr DurableAgent that works inside an OpenShell sandbox.

<env>
{env_block}
</env>

All file and command tools operate inside the active OpenShell sandbox, not inside the agent service container.

IMPORTANT -- Working directory:
- Your working directory is shown in the <env> block above.
- All tools resolve relative paths against the working directory. Use RELATIVE paths (e.g. "package.json", "src/app.html") — they automatically resolve to the correct location.
- Do NOT prefix paths with /sandbox/ — just use relative paths from the working directory.
- bash_run commands also execute in the working directory automatically.
- Treat /app as service implementation, not as a user workspace.

The sandbox is policy-governed, so filesystem and network access may be restricted. If a command fails, inspect the concise error and repair the smallest relevant issue before retrying.
"""


# Default system prompt used when no cwd is available yet
OPENSHELL_SYSTEM_PROMPT = _build_system_prompt("/sandbox")

# ---------------------------------------------------------------------------
# Model-to-component mapping for per-request model selection
# ---------------------------------------------------------------------------

MODEL_COMPONENT_MAP: dict[str, str] = {
    # Anthropic
    "anthropic/claude-sonnet-4-6": "llm-anthropic-sonnet",
    "anthropic/claude-opus-4-6": "llm-anthropic-opus",
    "anthropic/claude-haiku-4-5-20251001": "llm-anthropic-haiku",
    "claude-sonnet-4-6": "llm-anthropic-sonnet",
    "claude-opus-4-6": "llm-anthropic-opus",
    "claude-haiku-4-5-20251001": "llm-anthropic-haiku",
    # OpenAI
    "openai/gpt-5.4": "llm-openai-gpt5",
    "gpt-5.4": "llm-openai-gpt5",
    "openai/o3": "llm-openai-o3",
    "o3": "llm-openai-o3",
    # Google
    "google/gemini-3.1-pro": "llm-google-gemini",
    "gemini-3.1-pro": "llm-google-gemini",
    "gemini-3.1-pro-preview": "llm-google-gemini",
}
DEFAULT_LLM_COMPONENT = os.environ.get(
    "DAPR_LLM_COMPONENT_DEFAULT", "llm-anthropic-opus"
)


def _resolve_llm_component(message: dict, metadata: dict | None = None) -> str:
    """Extract modelSpec from agentConfig, metadata, or message and map to a Dapr component.

    Always returns a deterministic component name. Raises if an explicit
    modelSpec is provided but not found in MODEL_COMPONENT_MAP.
    """
    model_spec = ""

    # Priority 1: agentConfig.modelSpec
    agent_config = message.get("agentConfig")
    if isinstance(agent_config, dict):
        model_spec = agent_config.get("modelSpec", "")

    # Priority 2: metadata.model (passed via workflow metadata field)
    if not model_spec and metadata:
        model_spec = metadata.get("model", "")

    # Priority 3: top-level message.model
    if not model_spec:
        model_spec = message.get("model", "")

    if not isinstance(model_spec, str) or not model_spec.strip():
        return DEFAULT_LLM_COMPONENT

    model_spec = model_spec.strip()
    component = MODEL_COMPONENT_MAP.get(model_spec)
    if component is None:
        raise ValueError(
            f"Unknown modelSpec {model_spec!r}. "
            f"Available models: {', '.join(sorted(MODEL_COMPONENT_MAP.keys()))}"
        )
    return component

# ---------------------------------------------------------------------------
# Hot-reload configuration subscription
# ---------------------------------------------------------------------------


def on_config_change(key: str, value):
    logger.info("[hot-reload] %s = %s", key, value)


config = RuntimeSubscriptionConfig(
    store_name="runtime-config",
    keys=[
        # Profile
        RuntimeConfigKey.AGENT_ROLE,
        RuntimeConfigKey.AGENT_GOAL,
        RuntimeConfigKey.AGENT_INSTRUCTIONS,
        RuntimeConfigKey.AGENT_STYLE_GUIDELINES,
        RuntimeConfigKey.AGENT_SYSTEM_PROMPT,
        # Execution
        RuntimeConfigKey.MAX_ITERATIONS,
        RuntimeConfigKey.TOOL_CHOICE,
        # LLM
        RuntimeConfigKey.LLM_MODEL,
        RuntimeConfigKey.LLM_PROVIDER,
        RuntimeConfigKey.LLM_API_KEY,
    ],
    on_config_change=on_config_change,
)

# ---------------------------------------------------------------------------
# Infrastructure configs
# ---------------------------------------------------------------------------

AGENT_SERVICE_NAME = os.environ.get("AGENT_SERVICE_NAME", "dapr-agent-py")
AGENT_STATE_STORE = os.environ.get("AGENT_STATE_STORE", "dapr-agent-py-statestore")
AGENT_STATE_KEY_PREFIX = os.environ.get(
    "AGENT_STATE_KEY_PREFIX", f"{AGENT_SERVICE_NAME}:_workflow"
)
AGENT_MEMORY_KEY_PREFIX = os.environ.get(
    "AGENT_MEMORY_KEY_PREFIX", f"{AGENT_SERVICE_NAME}:_memory"
)
AGENT_PUBSUB_NAME = os.environ.get("DAPR_PUBSUB_NAME", "pubsub")
AGENT_TOPIC = os.environ.get("AGENT_TOPIC", f"{AGENT_SERVICE_NAME}.requests")
AGENT_BROADCAST_TOPIC = os.environ.get(
    "AGENT_BROADCAST_TOPIC", f"{AGENT_SERVICE_NAME}.broadcast"
)

state_config = AgentStateConfig(
    store=StateStoreService(store_name=AGENT_STATE_STORE)
)

pubsub_config = AgentPubSubConfig(
    pubsub_name=AGENT_PUBSUB_NAME,
    agent_topic=AGENT_TOPIC,
    broadcast_topic=AGENT_BROADCAST_TOPIC,
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


def _parse_metadata(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _parse_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _save_plan_to_state(execution_id: str, plan_content: str) -> None:
    """Save plan content to Dapr state store at a well-known key.

    Mirrors Claude Code's pattern of persisting plans to disk
    (~/.claude/plans/{slug}.md), adapted for Dapr state store.
    The plan can be retrieved by the UI via: GET /v1.0/state/{store}/plan:{id}
    """
    sidecar = (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )
    store = AGENT_STATE_STORE
    key = f"plan:{execution_id}"
    payload = json.dumps([{
        "key": key,
        "value": json.dumps({"plan": plan_content, "file": "PLAN.md"}),
    }]).encode()
    req = urllib.request.Request(
        f"{sidecar}/v1.0/state/{store}",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=5)


def _sandbox_name_from_workspace_ref(workspace_ref: str | None) -> str | None:
    if not workspace_ref:
        return None
    normalized = workspace_ref.strip()
    if not normalized.startswith("ws_"):
        return None
    return "ws-" + normalized[3:].replace("_", "-").lower()


def _normalize_mcp_server_name(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"^@activepieces/piece-", "", text)
    text = re.sub(r"[^a-z0-9_-]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_")
    if not text:
        text = "mcp_server"
    if not re.match(r"^[a-z_]", text):
        text = f"mcp_{text}"
    return text[:48]


def _normalize_tool_lookup_name(name: str) -> str:
    return str(name or "").lower().replace(" ", "").replace("_", "")


def _is_short_k8s_host(hostname: str) -> bool:
    if not hostname or "." in hostname:
        return False
    if hostname in {"localhost", "127.0.0.1", "::1"}:
        return False
    return (
        all(char.islower() or char.isdigit() or char == "-" for char in hostname)
        and hostname[0].isalnum()
        and hostname[-1].isalnum()
    )


def _should_qualify_mcp_url(server: dict[str, Any]) -> bool:
    source_type = str(server.get("sourceType") or server.get("source_type") or "")
    if source_type in {"nimble_piece", "nimble_shared", "hosted_workflow"}:
        return True
    registry_ref = str(server.get("registryRef") or server.get("registry_ref") or "")
    return registry_ref.startswith(("ap-", "nimble-", "shared-")) or registry_ref in {
        "mcp-gateway",
        "shared-workflow-mcp-server",
    }


def _runtime_reachable_mcp_url(server: dict[str, Any], url: str) -> str:
    text = str(url or "").strip()
    if not text or not _should_qualify_mcp_url(server):
        return text
    parsed = urllib.parse.urlparse(text)
    if parsed.scheme not in {"http", "https", "ws", "wss"} or not parsed.hostname:
        return text
    if not _is_short_k8s_host(parsed.hostname):
        return text

    namespace = str(
        server.get("namespace")
        or os.environ.get("MCP_CONNECTION_NAMESPACE")
        or os.environ.get("WORKFLOW_BUILDER_NAMESPACE")
        or "workflow-builder"
    ).strip()
    host = f"{parsed.hostname}.{namespace}.svc.cluster.local"
    if parsed.port:
        host = f"{host}:{parsed.port}"
    qualified = urllib.parse.urlunparse(parsed._replace(netloc=host))
    logger.info("Qualified MCP server URL for sandbox runtime: %s -> %s", text, qualified)
    return qualified


def _extract_mcp_server_configs(
    message: dict[str, Any],
) -> tuple[dict[str, dict[str, Any]], dict[str, set[str]]]:
    agent_config = message.get("agentConfig")
    if isinstance(agent_config, str) and agent_config.strip():
        try:
            parsed_config = json.loads(agent_config)
        except json.JSONDecodeError:
            logger.warning("[mcp] Skipping invalid JSON agentConfig")
            return {}, {}
        agent_config = parsed_config if isinstance(parsed_config, dict) else None
    if not isinstance(agent_config, dict):
        return {}, {}
    raw_servers = agent_config.get("mcpServers")
    if not isinstance(raw_servers, list):
        return {}, {}

    configs: dict[str, dict[str, Any]] = {}
    allowed_tools_by_server: dict[str, set[str]] = {}
    allowed_transports = {"streamable_http", "sse", "stdio", "websocket"}
    for item in raw_servers:
        if not isinstance(item, dict):
            continue
        raw_transport = str(
            item.get("transport") or item.get("type") or "streamable_http"
        ).strip().lower()
        transport = raw_transport.replace("-", "_")
        if transport in {"http", "streamablehttp"}:
            transport = "streamable_http"
        elif transport in {"ws", "web_socket"}:
            transport = "websocket"
        if transport not in allowed_transports:
            logger.warning("[mcp] Skipping unsupported MCP transport: %s", raw_transport)
            continue

        name_source = (
            item.get("server_name")
            or item.get("serverName")
            or item.get("name")
            or item.get("pieceName")
            or item.get("displayName")
            or item.get("url")
            or item.get("serverUrl")
            or item.get("command")
        )
        base_name = _normalize_mcp_server_name(name_source)
        server_name = base_name
        suffix = 2
        while server_name in configs:
            server_name = f"{base_name}_{suffix}"
            suffix += 1

        config: dict[str, Any] = {"transport": transport}
        if transport == "stdio":
            command = str(item.get("command") or "").strip()
            if not command:
                logger.warning(
                    "[mcp] Skipping stdio MCP server without command: %s",
                    item,
                )
                continue
            config["command"] = command
            if isinstance(item.get("args"), list):
                config["args"] = [str(arg) for arg in item["args"]]
            if isinstance(item.get("env"), dict):
                config["env"] = {
                    str(key): str(value)
                    for key, value in item["env"].items()
                    if str(key).strip() and value is not None
                }
            if isinstance(item.get("cwd"), str) and item["cwd"].strip():
                config["cwd"] = item["cwd"].strip()
        else:
            url = str(item.get("url") or item.get("serverUrl") or "").strip()
            allowed_url_prefixes = (
                ("ws://", "wss://")
                if transport == "websocket"
                else ("http://", "https://")
            )
            if not url.startswith(allowed_url_prefixes):
                logger.warning(
                    "[mcp] Skipping MCP server with invalid %s URL: %s",
                    transport,
                    item,
                )
                continue
            config["url"] = _runtime_reachable_mcp_url(item, url)
        headers = item.get("headers")
        if isinstance(headers, dict):
            safe_headers = {
                str(key): str(value)
                for key, value in headers.items()
                if str(key).strip() and value is not None
            }
            if safe_headers:
                config["headers"] = safe_headers
        for numeric_key in ("timeout", "sse_read_timeout"):
            value = item.get(numeric_key)
            if isinstance(value, (int, float)) and value > 0:
                config[numeric_key] = value
        if "terminate_on_close" in item and isinstance(item["terminate_on_close"], bool):
            config["terminate_on_close"] = item["terminate_on_close"]
        configs[server_name] = config
        raw_allowed_tools = item.get("allowedTools") or item.get("allowed_tools")
        if isinstance(raw_allowed_tools, list):
            allowed_tools = {
                str(tool).strip()
                for tool in raw_allowed_tools
                if str(tool).strip()
            }
            if allowed_tools:
                allowed_tools_by_server[server_name] = allowed_tools
    return configs, allowed_tools_by_server


def _extract_skill_configs(
    message: dict[str, Any],
) -> list[SkillDefinition]:
    """Extract skill definitions from ``agentConfig.skills``.

    Mirrors :func:`_extract_mcp_server_configs` for skill configuration
    passed via workflow trigger messages.
    """
    agent_config = message.get("agentConfig")
    if isinstance(agent_config, str) and agent_config.strip():
        try:
            agent_config = json.loads(agent_config)
        except json.JSONDecodeError:
            return []
    if not isinstance(agent_config, dict):
        return []
    raw_skills = agent_config.get("skills")
    if not isinstance(raw_skills, list):
        return []

    skills: list[SkillDefinition] = []
    for item in raw_skills:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        prompt = str(item.get("prompt") or "").strip()
        if not prompt:
            logger.warning("[skills] Skipping skill '%s' with empty prompt", name)
            continue
        allowed_tools_raw = item.get("allowed_tools") or item.get("allowedTools") or []
        allowed_tools = tuple(
            str(t).strip() for t in allowed_tools_raw if str(t).strip()
        ) if isinstance(allowed_tools_raw, list) else ()
        arguments_raw = item.get("arguments") or []
        arguments = tuple(
            str(a).strip() for a in arguments_raw if str(a).strip()
        ) if isinstance(arguments_raw, list) else ()
        skills.append(SkillDefinition(
            name=name,
            description=str(item.get("description") or ""),
            prompt=prompt,
            source="agentConfig",
            when_to_use=str(item.get("when_to_use") or item.get("whenToUse") or ""),
            allowed_tools=allowed_tools,
            arguments=arguments,
            argument_hint=str(item.get("argument_hint") or item.get("argumentHint") or ""),
            model_override=str(item.get("model") or ""),
            user_invocable=bool(item.get("user_invocable", item.get("userInvocable", True))),
            disable_model_invocation=bool(
                item.get("disable_model_invocation", item.get("disableModelInvocation", False))
            ),
        ))
    return skills


class OpenShellDurableAgent(DurableAgent):
    """DurableAgent wrapper that targets the requested OpenShell sandbox."""

    # Execution context stashed by agent_workflow for activity overrides
    _exec_id: str | None = None
    _inst_id: str | None = None
    _active_llm_instance_id: str | None = None

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._mcp_configs_by_instance: dict[str, dict[str, dict[str, Any]]] = {}
        self._mcp_clients_by_instance: dict[str, MCPClient] = {}
        self._mcp_config_hash_by_instance: dict[str, str] = {}
        self._mcp_tools_by_instance: dict[str, dict[str, Any]] = {}
        self._mcp_allowed_tools_by_instance: dict[str, dict[str, set[str]]] = {}

    async def _close_mcp_client_async(self, instance_id: str) -> None:
        client = self._mcp_clients_by_instance.pop(instance_id, None)
        self._mcp_config_hash_by_instance.pop(instance_id, None)
        self._mcp_tools_by_instance.pop(instance_id, None)
        self._mcp_allowed_tools_by_instance.pop(instance_id, None)
        self._mcp_configs_by_instance.pop(instance_id, None)
        if client is not None:
            await client.close()

    def _close_mcp_client(self, instance_id: str) -> None:
        if not instance_id:
            return
        try:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                self._run_asyncio_task(self._close_mcp_client_async(instance_id))
            else:
                loop.create_task(self._close_mcp_client_async(instance_id))
        except Exception as exc:
            logger.warning("[mcp] Failed to close MCP client for %s: %s", instance_id, exc)

    async def _ensure_mcp_client_async(self, instance_id: str) -> None:
        configs = self._mcp_configs_by_instance.get(instance_id) or {}
        if not configs:
            return
        config_hash = json.dumps(configs, sort_keys=True, default=str)
        if self._mcp_config_hash_by_instance.get(instance_id) == config_hash:
            return

        existing = self._mcp_clients_by_instance.pop(instance_id, None)
        if existing is not None:
            await existing.close()

        client = MCPClient(persistent_connections=False)
        try:
            await client.connect_from_config(configs)
        except Exception:
            await client.close()
            raise
        allowed_tools_by_server = (
            self._mcp_allowed_tools_by_instance.get(instance_id) or {}
        )
        tools: dict[str, Any] = {}
        for server_name in configs:
            allowed_tools = allowed_tools_by_server.get(server_name)
            allowed_lookup = (
                {
                    _normalize_tool_lookup_name(tool_name)
                    for tool_name in allowed_tools
                    if str(tool_name).strip()
                }
                if allowed_tools
                else set()
            )
            for tool in client.get_server_tools(server_name):
                raw_tool_name = str(getattr(tool, "name", "") or "")
                wrapped_prefix = f"{server_name}_"
                if raw_tool_name.startswith(wrapped_prefix):
                    raw_tool_name = raw_tool_name[len(wrapped_prefix) :]
                raw_lookup = _normalize_tool_lookup_name(raw_tool_name)
                tool_lookup = _normalize_tool_lookup_name(
                    str(getattr(tool, "name", "") or "")
                )
                if allowed_lookup and not (
                    raw_lookup in allowed_lookup
                    or tool_lookup in allowed_lookup
                    or any(
                        raw_lookup.endswith(allowed)
                        or tool_lookup.endswith(allowed)
                        for allowed in allowed_lookup
                    )
                ):
                    logger.debug(
                        "[mcp] Skipping tool outside allowlist: %s.%s",
                        server_name,
                        raw_tool_name,
                    )
                    continue
                tools[_normalize_tool_lookup_name(tool.name)] = tool
        self._mcp_clients_by_instance[instance_id] = client
        self._mcp_config_hash_by_instance[instance_id] = config_hash
        self._mcp_tools_by_instance[instance_id] = tools
        logger.info(
            "[mcp] Connected %d MCP server(s), loaded %d tool(s) for instance %s",
            len(configs),
            len(tools),
            instance_id,
        )

    def _ensure_mcp_client(self, instance_id: str) -> None:
        if not instance_id:
            return
        try:
            self._run_asyncio_task(self._ensure_mcp_client_async(instance_id))
        except Exception as exc:
            logger.warning(
                "[mcp] Failed to connect MCP servers for instance %s: %s",
                instance_id,
                exc,
            )

    def get_llm_tools(self):
        tools = list(super().get_llm_tools())
        instance_id = self._active_llm_instance_id or self._inst_id or ""
        mcp_tools = self._mcp_tools_by_instance.get(instance_id) or {}
        if not mcp_tools:
            return tools

        existing_names = {
            _normalize_tool_lookup_name(getattr(tool, "name", ""))
            for tool in tools
        }
        for key, tool in mcp_tools.items():
            if key in existing_names:
                logger.warning("[mcp] Skipping MCP tool name collision: %s", tool.name)
                continue
            tools.append(tool)
        return tools

    def call_llm(self, ctx, payload):
        """Publish llm_start/llm_complete streaming events with content."""
        # Re-apply Anthropic adapter on each call (survives durable workflow replay)
        try:
            from src.anthropic_adapter import patch_for_anthropic
            patch_for_anthropic(self.llm)
        except Exception:
            pass

        exec_id = self._exec_id or ""
        inst_id = self._inst_id or payload.get("instance_id", "")
        component = getattr(self.llm, "_llm_component", None)
        self._ensure_mcp_client(inst_id)

        # Suppress tool_choice for Anthropic components — the Dapr langchaingo
        # Anthropic adapter passes tool_choice as a string ("auto") but the
        # Anthropic API expects a dict ({"type": "auto"}), causing HTTP 400.
        # Workaround: temporarily clear tool_choice for Anthropic calls.
        saved_tool_choice = None
        if component and "anthropic" in component:
            saved_tool_choice = self.execution.tool_choice
            self.execution.tool_choice = None

        try:
            publish_llm_start(exec_id, inst_id, model=component)
        except Exception:
            pass
        try:
            self._active_llm_instance_id = inst_id
            result = super().call_llm(ctx, payload)
        except Exception as exc:
            try:
                publish_llm_complete(exec_id, inst_id)
            except Exception:
                pass
            raise
        finally:
            self._active_llm_instance_id = None
            # Restore tool_choice if it was suppressed for Anthropic
            if saved_tool_choice is not None:
                self.execution.tool_choice = saved_tool_choice
        # Extract content summary from the assistant message
        content = ""
        tool_calls = []
        if isinstance(result, dict):
            raw = result.get("content", "")
            if isinstance(raw, str):
                content = raw[:500]
            elif isinstance(raw, list):
                content = " ".join(
                    b.get("text", "")[:200] for b in raw if isinstance(b, dict) and b.get("type") == "text"
                )[:500]
            tc = result.get("tool_calls")
            if isinstance(tc, list):
                tool_calls = [
                    t.get("function", {}).get("name", "") for t in tc if isinstance(t, dict)
                ]
        try:
            publish_llm_complete(exec_id, inst_id, content=content, tool_calls=tool_calls)
        except Exception:
            pass
        return result

    def run_tool(self, ctx, payload):
        """Publish tool_call_start/end streaming events with content."""
        exec_id = self._exec_id or ""
        inst_id = self._inst_id or payload.get("instance_id", "")
        tool_call = payload.get("tool_call", {})
        func = tool_call.get("function", {}) if isinstance(tool_call, dict) else {}
        tool_name = func.get("name", "unknown") if isinstance(func, dict) else "unknown"
        tool_args = {}
        raw_args = func.get("arguments", "")
        if isinstance(raw_args, str) and raw_args.strip():
            try:
                tool_args = json.loads(raw_args)
            except Exception:
                pass
        if (
            isinstance(tool_args, dict)
            and len(tool_args) == 1
            and "kwargs" in tool_args
            and isinstance(tool_args.get("kwargs"), dict)
        ):
            tool_args = tool_args["kwargs"]
        if not isinstance(tool_args, dict):
            tool_args = {}
        try:
            publish_tool_start(exec_id, inst_id, tool_name, tool_args=tool_args)
        except Exception:
            pass
        try:
            if inst_id and not (self._mcp_tools_by_instance.get(inst_id) or {}):
                self._ensure_mcp_client(inst_id)
            mcp_tool = (self._mcp_tools_by_instance.get(inst_id) or {}).get(
                _normalize_tool_lookup_name(tool_name)
            )
            if mcp_tool is not None:
                async def _execute_mcp_tool():
                    return await mcp_tool.arun(**tool_args)

                try:
                    mcp_result = self._run_asyncio_task(_execute_mcp_tool())
                    serialized_result = serialize_tool_result(mcp_result)
                except Exception as exc:
                    error = str(exc)
                    try:
                        publish_tool_complete(
                            exec_id,
                            inst_id,
                            tool_name,
                            success=False,
                            error=error[:200],
                        )
                    except Exception:
                        pass
                    tool_result = ToolMessage(
                        content=f"Tool {tool_name} failed: {error}",
                        role="tool",
                        name=tool_name,
                        tool_call_id=tool_call["id"],
                    )
                    try:
                        self.text_formatter.print_message(tool_result)
                    except Exception:
                        pass
                    return tool_result.model_dump()
                tool_result = ToolMessage(
                    content=serialized_result,
                    role="tool",
                    name=tool_name,
                    tool_call_id=tool_call["id"],
                )
                try:
                    self.text_formatter.print_message(tool_result)
                except Exception:
                    pass
                result = tool_result.model_dump()
            else:
                result = super().run_tool(ctx, payload)
        except Exception as exc:
            try:
                publish_tool_complete(exec_id, inst_id, tool_name, success=False, error=str(exc)[:200])
            except Exception:
                pass
            raise
        # Extract tool output summary
        output = ""
        if isinstance(result, dict):
            raw = result.get("content", "")
            if isinstance(raw, str):
                output = raw[:500]
        try:
            publish_tool_complete(exec_id, inst_id, tool_name, success=True, output=output)
        except Exception:
            pass
        return result

    @workflow_entry
    @message_router(message_model=TriggerAction)
    def agent_workflow(self, ctx, message: dict):
        metadata = _parse_metadata(message.get("metadata")) | _parse_metadata(
            message.get("_message_metadata")
        )
        sandbox_name = (
            str(message.get("sandboxName") or metadata.get("sandboxName") or "").strip()
            or _sandbox_name_from_workspace_ref(
                str(message.get("workspaceRef") or metadata.get("workspace_ref") or "")
            )
        )
        cwd = str(message.get("cwd") or metadata.get("cwd") or "").strip()

        runtime = get_runtime()
        runtime.set_sandbox_name(sandbox_name)
        runtime.set_cwd(cwd or DEFAULT_CWD)

        # Set system prompt dynamically with <env> block (mirrors prompts.ts)
        previous_system_prompt = self.profile.system_prompt
        self.profile.system_prompt = _build_system_prompt(
            cwd=runtime.cwd,
            sandbox_name=sandbox_name or None,
        )

        max_iterations = (
            _parse_int(message.get("maxIterations"))
            or _parse_int(message.get("maxTurns"))
            or _parse_int(metadata.get("maxIterations"))
            or _parse_int(metadata.get("maxTurns"))
        )

        # Prepend only non-overlapping context (cwd/sandbox are now in system prompt)
        task = message.get("task") or message.get("prompt")
        if isinstance(task, str):
            context_lines = []
            if message.get("workspaceRef"):
                context_lines.append(f"Workspace ref: {message.get('workspaceRef')}")
            stop_condition = message.get("stopCondition")
            if isinstance(stop_condition, str) and stop_condition.strip():
                context_lines.append(f"Stop condition: {stop_condition.strip()}")
            if context_lines:
                message = {
                    **message,
                    "task": "Execution context:\n"
                    + "\n".join(f"- {line}" for line in context_lines)
                    + "\n\n"
                    + task,
                }

        # Inject plan from PLAN.md if it exists in the sandbox.
        # Mirrors claude-code-src plan_file_reference attachment
        # (messages.ts:3636-3642): the plan content is prepended to the
        # user's first message so the agent has it in context without
        # needing an extra Read tool call.
        #
        # Guard with is_replaying: the sandbox read is a side effect that
        # should only happen on the initial execution, not on durable
        # workflow replays. The injected task is already persisted in the
        # workflow state after the first run.
        if not ctx.is_replaying:
            try:
                plan_path = runtime.resolve_path("PLAN.md")
                plan_result = runtime.read_text(plan_path)
                if plan_result.get("ok") and plan_result.get("content"):
                    plan_content = str(plan_result["content"])
                    plan_injection = (
                        f"A plan file exists at PLAN.md\n\n"
                        f"Plan contents:\n\n{plan_content}\n\n"
                        f"If this plan is relevant to the current work "
                        f"and not already complete, continue working on it."
                    )
                    current_task = message.get("task") or message.get("prompt") or ""
                    if isinstance(current_task, str):
                        message = {
                            **message,
                            "task": plan_injection + "\n\n" + current_task,
                        }
                        logger.info(
                            "[plan] Injected PLAN.md (%d chars) into task",
                            len(plan_content),
                        )
            except Exception:
                pass  # No PLAN.md = first phase or no plan written

        # Select LLM component based on agentConfig.modelSpec or metadata.model
        llm_component = _resolve_llm_component(message, metadata)
        previous_component = self.llm._llm_component
        self.llm._llm_component = llm_component
        if not ctx.is_replaying:
            logger.info("[model-select] Using LLM component: %s", llm_component)
            logger.info("[metadata] model=%s", metadata.get("model"))

        previous_max_iterations = self.execution.max_iterations
        if max_iterations:
            self.execution.max_iterations = max_iterations

        # Derive execution context for event streaming
        # Prefer db_execution_id (the workflow-builder database ID used by the UI)
        # over execution_id (the orchestrator's internal ID with sw-*-exec- prefix).
        instance_id = getattr(ctx, "instance_id", None) or ""
        execution_id = (
            str(message.get("dbExecutionId") or "").strip()
            or str(message.get("workflowExecutionId") or "").strip()
            or str(message.get("executionId") or "").strip()
            or metadata.get("db_execution_id")
            or metadata.get("dbExecutionId")
            or metadata.get("parentExecutionId")
            or metadata.get("parent_execution_id")
            or metadata.get("executionId")
            or metadata.get("execution_id")
            or instance_id
        )

        # Stash for activity overrides (call_llm, run_tool)
        self._exec_id = execution_id
        self._inst_id = instance_id
        mcp_configs, mcp_allowed_tools = _extract_mcp_server_configs(message)
        if mcp_configs:
            self._mcp_configs_by_instance[instance_id] = mcp_configs
            self._mcp_allowed_tools_by_instance[instance_id] = mcp_allowed_tools
            logger.info(
                "[mcp] Registered %d MCP server config(s) for instance %s",
                len(mcp_configs),
                instance_id,
            )
        # Extract per-instance skill configs (parallel to MCP extraction)
        skill_registry = get_skill_registry()
        instance_skill_defs = _extract_skill_configs(message)
        if instance_skill_defs:
            skill_registry.set_instance_skills(instance_skill_defs)
            logger.info(
                "[skills] Registered %d instance skill(s) for instance %s",
                len(instance_skill_defs),
                instance_id,
            )

        # Append skill listings to system prompt so the model knows what's available
        available_skills = skill_registry.list_available()
        if available_skills:
            skill_listing_block = format_skill_listings(available_skills)
            if skill_listing_block:
                self.profile.system_prompt += "\n\n" + skill_listing_block

        if not ctx.is_replaying:
            logger.info("[exec-id] execution_id=%s instance_id=%s", execution_id, instance_id)

        # Publish workflow started event (only on first execution, not replays)
        if not ctx.is_replaying:
            try:
                publish_workflow_started(
                    execution_id=execution_id,
                    instance_id=instance_id,
                    task=str(message.get("task") or message.get("prompt") or "")[:500],
                    model=llm_component,
                )
            except Exception:
                pass

        try:
            yield from super().agent_workflow(ctx, message)

            # After agent completes, check for PLAN.md and persist full content
            # to Dapr state store (mirrors Claude Code's file-based plan persistence)
            try:
                plan_path = runtime.resolve_path("PLAN.md")
                logger.info("[plan] Attempting to read %s from sandbox %s", plan_path, sandbox_name)
                plan_result = runtime.read_text(plan_path)
                logger.info("[plan] read_text result: ok=%s, has_content=%s",
                            plan_result.get("ok"), bool(plan_result.get("content")))
                if plan_result.get("ok") and plan_result.get("content"):
                    plan_content = str(plan_result["content"])
                    _save_plan_to_state(execution_id, plan_content)
                    publish_event(
                        "plan_artifact",
                        {"content": plan_content, "file": "PLAN.md"},
                        execution_id=execution_id,
                        instance_id=instance_id,
                    )
                    logger.info(
                        "[plan] Persisted PLAN.md (%d chars) to state store for %s",
                        len(plan_content),
                        execution_id,
                    )
                elif not plan_result.get("ok"):
                    logger.info("[plan] PLAN.md not found or unreadable: %s",
                                plan_result.get("error", "unknown"))
            except Exception as exc:
                logger.warning("[plan] Failed to read/persist PLAN.md: %s", exc)

            try:
                publish_workflow_completed(
                    execution_id=execution_id,
                    instance_id=instance_id,
                    success=True,
                )
            except Exception:
                pass
            self._close_mcp_client(instance_id)
        except Exception as exc:
            try:
                publish_workflow_completed(
                    execution_id=execution_id,
                    instance_id=instance_id,
                    success=False,
                    error=str(exc)[:500],
                )
            except Exception:
                pass
            self._close_mcp_client(instance_id)
            raise
        finally:
            self.execution.max_iterations = previous_max_iterations
            self.llm._llm_component = previous_component
            self.profile.system_prompt = previous_system_prompt
            skill_registry.clear_instance_skills()


# ---------------------------------------------------------------------------
# Load disk-based skills at startup
# ---------------------------------------------------------------------------

_SKILL_SEARCH_DIRS = [
    os.path.join(os.path.dirname(__file__), "..", "skills"),  # project skills/
    os.path.join(os.path.dirname(__file__), "..", ".claude", "skills"),
]

for _skills_dir in _SKILL_SEARCH_DIRS:
    _abs_dir = os.path.abspath(_skills_dir)
    if os.path.isdir(_abs_dir):
        _disk_skills = load_skills_from_dir(_abs_dir, source="disk")
        if _disk_skills:
            get_skill_registry().set_disk_skills(_disk_skills)
            logger.info("[skills] Loaded %d disk skill(s) from %s", len(_disk_skills), _abs_dir)


agent = OpenShellDurableAgent(
    name=AGENT_SERVICE_NAME,
    role="OpenShell Durable Coding Agent",
    goal="Help users inspect, modify, and execute code safely inside an OpenShell sandbox",
    system_prompt=OPENSHELL_SYSTEM_PROMPT,
    instructions=[
        "Think step by step",
        "Use the existing dapr-agent-py tools for all file and command work",
        "Keep command output concise",
    ],
    style_guidelines=["Be professional and direct"],
    llm=DaprChatClient(component_name=DEFAULT_LLM_COMPONENT),
    tools=all_tools,
    execution=AgentExecutionConfig(max_iterations=DEFAULT_MAX_ITERATIONS),
    configuration=config,
    state=state_config,
    pubsub=pubsub_config,
    registry=registry_config,
    agent_metadata={
        "service": AGENT_SERVICE_NAME,
        "stateStore": AGENT_STATE_STORE,
        "stateSchema": "dapr-agents-durable-default",
        "stateKeyPrefix": AGENT_STATE_KEY_PREFIX,
        "memoryKeyPrefix": AGENT_MEMORY_KEY_PREFIX,
        "instancesEndpoint": "/agent/instances",
        "pubsub": AGENT_PUBSUB_NAME,
        "agentTopic": AGENT_TOPIC,
        "broadcastTopic": AGENT_BROADCAST_TOPIC,
    },
)

# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

# Patch DaprChatClient for Anthropic — the Dapr sidecar's langchaingo layer
# sends tool_choice as a string even when None/not-passed, breaking Anthropic.
# This is a Go-side bug that can't be fixed from Python.
try:
    from src.anthropic_adapter import patch_for_anthropic
    patch_for_anthropic(agent.llm)
except Exception as exc:
    logger.warning("Anthropic adapter patch failed: %s", exc)

runner = AgentRunner()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("%s starting", AGENT_SERVICE_NAME)
    yield
    logger.info("%s shutting down", AGENT_SERVICE_NAME)
    runner.shutdown(agent)


app = FastAPI(
    title=AGENT_SERVICE_NAME,
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
    store_name = AGENT_STATE_STORE
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
    workflow_state_key = f"{AGENT_STATE_KEY_PREFIX}_{instance_id}".lower()
    memory_key = f"{AGENT_MEMORY_KEY_PREFIX}_{instance_id}".lower()
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
        "workflow_name": AGENT_SERVICE_NAME,
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
        "storeName": AGENT_STATE_STORE,
        "agentName": AGENT_SERVICE_NAME,
        "stateKey": f"{AGENT_STATE_KEY_PREFIX}_<instance_id>",
        "memoryKey": f"{AGENT_MEMORY_KEY_PREFIX}_<instance_id>",
        "found": True,
        "instances": instances,
    }


@app.get("/plan/{execution_id}")
async def get_plan(execution_id: str) -> dict:
    """Read a persisted plan from the Dapr state store."""
    key = f"plan:{execution_id}"
    plan_data = _read_agent_state_key(key)
    if plan_data is None:
        return {"plan": None}
    if isinstance(plan_data, dict) and "plan" in plan_data:
        return {"plan": plan_data["plan"]}
    if isinstance(plan_data, str):
        return {"plan": plan_data}
    return {"plan": None}


@app.get("/healthz")
async def health_check() -> dict:
    return {"status": "healthy", "service": AGENT_SERVICE_NAME}


@app.get("/readyz")
async def readiness_check() -> dict:
    return {"status": "ready", "service": AGENT_SERVICE_NAME}
