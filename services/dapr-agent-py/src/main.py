"""Minimal Python durable agent with hot-reload configuration."""

from __future__ import annotations

import logging
import asyncio
import json
import os
import posixpath
import re
import shlex
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from dataclasses import replace
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.encoders import jsonable_encoder
from google.protobuf import wrappers_pb2
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# OpenTelemetry initialization (must happen before FastAPI app creation)
# ---------------------------------------------------------------------------

from src.telemetry import init_telemetry, is_telemetry_ready
from src.telemetry.metrics import init_metrics as _init_claude_code_metrics

_otel_ready = init_telemetry()
if _otel_ready:
    _init_claude_code_metrics()


def _start_checkpoint_span(tool_name: str, tool_call_id: str):
    """Return a context manager for a git-checkpoint span; no-op when OTEL is unavailable."""
    if not is_telemetry_ready():
        from contextlib import nullcontext

        return nullcontext()
    try:
        from opentelemetry import trace

        tracer = trace.get_tracer("dapr-agent-py.checkpoint")
        return tracer.start_as_current_span(
            "capture_code_checkpoint",
            attributes={
                "tool.name": tool_name or "",
                "tool.call_id": tool_call_id or "",
            },
        )
    except Exception:
        from contextlib import nullcontext

        return nullcontext()


# ---------------------------------------------------------------------------
# Agent setup (imported after OTEL so spans are captured)
# ---------------------------------------------------------------------------

from src.tools import all_tools
from src.tools.skill_tool import get_registry as get_skill_registry, load_skills_from_dir, parse_skill_md
from src.tools.skill_tool.models import SkillDefinition
from src.tools.skill_tool.prompt import format_skill_listings
from src.openshell_runtime import DEFAULT_CWD, get_runtime
from src.code_checkpoint import (
    capture_code_checkpoint,
    restore_code_checkpoint,
    should_checkpoint_tool,
)
from src.event_publisher import publish_session_event, scope_session, unscope_session
from src.session_outputs import scan_and_upload as _scan_session_outputs
from src.hooks import (
    HooksSnapshot,
    execute_notification_hooks,
    execute_post_tool_hooks,
    execute_post_tool_use_failure_hooks,
    execute_pre_tool_hooks,
    execute_session_end_hooks,
    execute_session_start_hooks,
    execute_stop_hooks,
    execute_user_prompt_submit_hooks,
    hooks_enabled,
)
from src.hooks.registry import empty_snapshot
from src.plugins import (
    apply_per_run as _apply_per_run_hooks,
    bootstrap as _bootstrap_hooks_and_plugins,
    clear_instance_snapshot as _clear_hook_snapshot,
    current_snapshot as _current_hook_snapshot,
    install_instance_snapshot as _install_hook_snapshot,
)

from dapr_agents.agents.configs import (
    AgentExecutionConfig,
    AgentPubSubConfig,
    AgentRegistryConfig,
    AgentStateConfig,
    RuntimeConfigKey,
    RuntimeSubscriptionConfig,
    WorkflowRetryPolicy,
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
    "anthropic/claude-opus-4-7": "llm-anthropic-opus",
    "anthropic/claude-opus-4-6": "llm-anthropic-opus",
    "anthropic/claude-haiku-4-5-20251001": "llm-anthropic-haiku",
    "claude-sonnet-4-6": "llm-anthropic-sonnet",
    "claude-opus-4-7": "llm-anthropic-opus",
    "claude-opus-4-6": "llm-anthropic-opus",
    "claude-haiku-4-5-20251001": "llm-anthropic-haiku",
    # OpenAI
    "openai/gpt-5.4": "llm-openai-gpt5",
    "gpt-5.4": "llm-openai-gpt5",
    "openai/o3": "llm-openai-o3",
    "o3": "llm-openai-o3",
}
DEFAULT_LLM_COMPONENT = os.environ.get(
    "DAPR_LLM_COMPONENT_DEFAULT", "llm-anthropic-opus"
)


def _coerce_agent_config(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _resolve_llm_component(message: dict, metadata: dict | None = None) -> str:
    """Extract modelSpec from agentConfig, metadata, or message and map to a Dapr component.

    Always returns a deterministic component name. Raises if an explicit
    modelSpec is provided but not found in MODEL_COMPONENT_MAP.
    """
    model_spec = ""

    # Priority 1: agentConfig.modelSpec
    agent_config = _coerce_agent_config(message.get("agentConfig"))
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


def _extract_code_checkpoint_restore(
    message: dict[str, Any],
    metadata: dict[str, Any],
) -> dict[str, Any]:
    for value in (
        message.get("codeCheckpointRestore"),
        metadata.get("codeCheckpointRestore"),
        metadata.get("code_checkpoint_restore"),
    ):
        parsed = _parse_metadata(value)
        if parsed:
            return parsed
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
    agent_config = _coerce_agent_config(message.get("agentConfig"))
    if message.get("agentConfig") and not isinstance(agent_config, dict):
        logger.warning("[mcp] Skipping invalid JSON agentConfig")
    if not isinstance(agent_config, dict):
        logger.info(
            "[mcp] extract: agentConfig absent/invalid — top-level message keys=%s",
            list(message.keys()) if isinstance(message, dict) else type(message).__name__,
        )
        return {}, {}
    raw_servers = agent_config.get("mcpServers")
    if not isinstance(raw_servers, list):
        logger.info(
            "[mcp] extract: agentConfig has no mcpServers list — agentConfig keys=%s "
            "(raw_servers type=%s)",
            list(agent_config.keys()),
            type(raw_servers).__name__,
        )
        return {}, {}
    logger.info(
        "[mcp] extract: agentConfig.mcpServers has %d entr%s",
        len(raw_servers),
        "y" if len(raw_servers) == 1 else "ies",
    )

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
        package_files = _extract_skill_package_file_paths(item)
        skills.append(SkillDefinition(
            name=name,
            description=str(item.get("description") or ""),
            prompt=prompt,
            source="agentConfig",
            when_to_use=str(item.get("when_to_use") or item.get("whenToUse") or ""),
            allowed_tools=allowed_tools,
            arguments=arguments,
            argument_hint=str(item.get("argument_hint") or item.get("argumentHint") or ""),
            model_override=str(
                item.get("model")
                or item.get("modelOverride")
                or item.get("model_override")
                or ""
            ),
            user_invocable=bool(item.get("user_invocable", item.get("userInvocable", True))),
            disable_model_invocation=bool(
                item.get("disable_model_invocation", item.get("disableModelInvocation", False))
            ),
            package_files=package_files,
        ))
    return skills


def _extract_raw_skill_items(message: dict[str, Any]) -> list[dict[str, Any]]:
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
    return [item for item in raw_skills if isinstance(item, dict)]


def _extract_runtime_skill_refs(message: dict[str, Any]) -> list[dict[str, str]]:
    refs: list[dict[str, str]] = []
    for item in _extract_raw_skill_items(message):
        source = str(
            item.get("installSource")
            or item.get("sourceRepo")
            or item.get("source")
            or ""
        ).strip()
        skill_name = str(item.get("skillName") or item.get("name") or "").strip()
        if not source or not skill_name:
            continue
        source = re.sub(r"^https://github\.com/", "", source).strip("/")
        source = re.sub(r"^https://skills\.sh/", "", source).strip("/")
        if not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", source):
            logger.warning("[skills] Skipping skill with invalid install source: %s", source)
            continue
        if not re.match(r"^[A-Za-z0-9_. -]+$", skill_name):
            logger.warning("[skills] Skipping skill with invalid skill name: %s", skill_name)
            continue
        install_agent = str(item.get("installAgent") or "universal").strip() or "universal"
        allowed_tools_raw = item.get("allowedTools") or item.get("allowed_tools") or []
        allowed_tools = ",".join(
            str(tool).strip()
            for tool in (allowed_tools_raw if isinstance(allowed_tools_raw, list) else [])
            if str(tool).strip()
        )
        refs.append(
            {
                "source": source,
                "skill": skill_name,
                "install_agent": install_agent,
                "allowed_tools": allowed_tools,
            }
        )
    return refs


def _runtime_skill_run_dir(instance_id: str) -> str:
    return f"/sandbox/.workflow-builder/skill-runs/{_safe_skill_segment(instance_id or 'instance')}"


def _scan_runtime_skill_install_root(
    runtime,
    install_root: str,
    refs: list[dict[str, str]],
) -> list[SkillDefinition]:
    scan = runtime.run_python(
        """
import json, pathlib, sys
root = pathlib.Path(json.loads(sys.stdin.read())["root"])
items = []
for path in sorted(root.rglob("SKILL.md")):
    parts = set(path.parts)
    if "node_modules" in parts or ".git" in parts:
        continue
    try:
        items.append({
            "name": path.parent.name,
            "path": str(path),
            "package_path": str(path.parent),
            "content": path.read_text(encoding="utf-8"),
        })
    except Exception as exc:
        items.append({"name": path.parent.name, "path": str(path), "error": str(exc)})
print(json.dumps({"ok": True, "items": items}))
        """.strip(),
        {"root": install_root},
        timeout_seconds=60,
    )
    if not scan.get("ok"):
        raise RuntimeError(f"Failed to scan installed skills: {scan.get('output') or scan.get('error')}")
    try:
        payload = json.loads(scan.get("stdout") or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Failed to parse installed skill scan: {exc}") from exc

    allowed_by_name = {
        ref["skill"]: tuple(part for part in ref.get("allowed_tools", "").split(",") if part)
        for ref in refs
    }
    loaded: list[SkillDefinition] = []
    for item in payload.get("items") or []:
        if not isinstance(item, dict) or not item.get("content"):
            continue
        fallback_name = str(item.get("name") or "skill")
        skill = parse_skill_md(str(item["content"]), name=fallback_name, source="agentConfig")
        allowed_tools = (
            allowed_by_name.get(skill.name)
            or allowed_by_name.get(fallback_name)
            or skill.allowed_tools
        )
        loaded.append(
            replace(
                skill,
                allowed_tools=allowed_tools,
                package_path=str(item.get("package_path") or ""),
                package_files=("SKILL.md",),
            )
        )
    return loaded


def _install_runtime_skill_refs(runtime, instance_id: str, refs: list[dict[str, str]]) -> list[SkillDefinition]:
    if not refs:
        return []
    install_root = _runtime_skill_run_dir(instance_id)
    for ref in refs:
        source_arg = f"{ref['source']}@{ref['skill']}"
        command = (
            f"mkdir -p {shlex.quote(install_root)} && "
            f"cd {shlex.quote(install_root)} && "
            "export SSL_CERT_FILE=${SSL_CERT_FILE:-/etc/ssl/certs/ca-certificates.crt} && "
            "export GIT_SSL_CAINFO=${GIT_SSL_CAINFO:-$SSL_CERT_FILE} && "
            f"npx --yes skills@1.5.0 add {shlex.quote(source_arg)} "
            f"--agent {shlex.quote(ref['install_agent'])} --copy --yes"
        )
        result = runtime.execute(command, timeout_seconds=180)
        if not result.get("ok"):
            raise RuntimeError(
                f"Failed to install skill {source_arg}: "
                f"{result.get('output') or result.get('error') or 'unknown error'}"
            )
        logger.info("[skills] Installed runtime skill %s into %s", source_arg, install_root)

    loaded = _scan_runtime_skill_install_root(runtime, install_root, refs)
    if not loaded:
        requested = ", ".join(f"{ref['source']}@{ref['skill']}" for ref in refs)
        raise RuntimeError(
            f"Installed runtime skill reference(s), but no SKILL.md files were loaded from "
            f"{install_root}: {requested}"
        )
    return loaded


def _safe_skill_segment(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip()).strip(".-")
    return normalized[:96] or "skill"


def _safe_package_relative_path(value: Any) -> str | None:
    raw = str(value or "").replace("\\", "/").strip()
    if not raw:
        return None
    normalized = posixpath.normpath(raw).lstrip("/")
    if normalized in {"", "."} or normalized.startswith("../"):
        return None
    return normalized


def _extract_skill_package_entries(item: dict[str, Any]) -> list[dict[str, str]]:
    manifest = item.get("packageManifest")
    if not isinstance(manifest, dict):
        return []
    raw_files = manifest.get("files")
    if not isinstance(raw_files, list):
        return []
    entries: list[dict[str, str]] = []
    total_bytes = 0
    for raw_file in raw_files:
        if not isinstance(raw_file, dict):
            continue
        rel_path = _safe_package_relative_path(raw_file.get("path"))
        content = raw_file.get("content")
        if not rel_path or not isinstance(content, str):
            continue
        encoded_size = len(content.encode("utf-8"))
        if encoded_size > 64 * 1024:
            logger.warning("[skills] Skipping oversized package file %s", rel_path)
            continue
        if total_bytes + encoded_size > 256 * 1024:
            logger.warning("[skills] Skipping package file %s because package limit was reached", rel_path)
            continue
        total_bytes += encoded_size
        entries.append({"path": rel_path, "content": content})
        if len(entries) >= 40:
            break
    return entries


def _extract_skill_package_file_paths(item: dict[str, Any]) -> tuple[str, ...]:
    return tuple(entry["path"] for entry in _extract_skill_package_entries(item))


def _materialize_instance_skill_packages(
    runtime,
    skills: list[SkillDefinition],
    instance_id: str,
    raw_skill_items: list[dict[str, Any]],
    *,
    write_files: bool,
) -> list[SkillDefinition]:
    """Write imported skill package files into the active sandbox.

    Imported skills may include references, scripts, or examples next to
    SKILL.md. The agent receives those files through agentConfig rather than
    through the image, so they need to be materialized into the current
    OpenShell workspace before the Skill tool advertises them.
    """
    updated: list[SkillDefinition] = []
    safe_instance = _safe_skill_segment(instance_id or "instance")
    items_by_name = {
        str(item.get("name") or "").strip(): item
        for item in raw_skill_items
        if isinstance(item, dict)
    }
    for skill in skills:
        item = items_by_name.get(skill.name) or {}
        package_entries = _extract_skill_package_entries(item)
        if not package_entries:
            updated.append(skill)
            continue
        package_dir = f"/sandbox/.workflow-builder/skills/{safe_instance}/{_safe_skill_segment(skill.name)}"
        if write_files:
            for entry in package_entries:
                target_path = posixpath.join(package_dir, entry["path"])
                result = runtime.write_text(target_path, entry["content"])
                if not result.get("ok"):
                    logger.warning(
                        "[skills] Failed to materialize %s for skill %s: %s",
                        entry["path"],
                        skill.name,
                        result.get("error") or result.get("output"),
                    )
            logger.info(
                "[skills] Materialized %d package file(s) for skill %s at %s",
                len(package_entries),
                skill.name,
                package_dir,
            )
        updated.append(
            replace(
                skill,
                package_path=package_dir,
                package_files=tuple(entry["path"] for entry in package_entries),
            )
        )
    return updated


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
        self._skills_by_instance: dict[str, list[SkillDefinition]] = {}
        self._workspace_ref_by_instance: dict[str, str] = {}
        # Per-instance session id: populated when session_workflow spawns
        # agent_workflow as a child. Activities thread it into
        # publish_session_event so every agent event lands in session_events.
        self._session_id_by_instance: dict[str, str] = {}
        # Hooks/plugins: populated by plugins.integration.bootstrap(agent) at
        # service boot. Defaults keep the attributes safe to touch even when
        # DAPR_AGENT_PY_HOOKS_ENABLED=false.
        self._hook_registry = None
        self._plugin_registry = None
        self._base_hooks_snapshot: HooksSnapshot = empty_snapshot()
        self._hooks_snapshot_by_instance: dict[str, HooksSnapshot] = {}
        self._cwd_by_instance: dict[str, str] = {}
        # Compaction: per-instance resolved config + monotonic call_llm counter
        # used as the turn_index for idempotency markers.
        from src.compaction import CompactionConfig

        self._compaction_cfg_by_instance: dict[str, CompactionConfig] = {}
        self._compaction_call_count_by_instance: dict[str, int] = {}
        self._compaction_runs_by_instance: dict[str, int] = {}
        # Per-instance claude_code.interaction span handles (telemetry).
        # Populated on the first non-replay tick; ended in the workflow's
        # try/finally on non-replay ticks only.
        self._interaction_span_by_instance: dict[str, Any] = {}
        self._interaction_ctx_token_by_instance: dict[str, Any] = {}

    def _activate_instance_skills(self, instance_id: str) -> None:
        if not instance_id:
            return
        skills = self._skills_by_instance.get(instance_id)
        if skills:
            get_skill_registry().set_instance_skills(skills)

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
        self._activate_instance_skills(inst_id)
        self._ensure_mcp_client(inst_id)

        # ---- Context compaction (inline, same activity boundary) -----------
        # Runs BEFORE the base call_llm. If compaction triggers it rewrites
        # entry.messages via save_state; super().call_llm() will reload the
        # compacted state. Failures are advisory and never block call_llm.
        try:
            from src.anthropic_adapter import _call_anthropic_sdk, _get_anthropic_model
            from src.compaction import maybe_compact

            cfg = self._compaction_cfg_by_instance.get(inst_id)
            if cfg is not None and cfg.enabled:
                turn_index = self._compaction_call_count_by_instance.get(inst_id, 0)
                self._compaction_call_count_by_instance[inst_id] = turn_index + 1
                model_id = (
                    _get_anthropic_model(component)
                    if component and "anthropic" in component
                    else (component or None)
                )
                runtime_for_compact = get_runtime()
                result = maybe_compact(
                    self,
                    instance_id=inst_id,
                    execution_id=exec_id,
                    config=cfg,
                    model=model_id,
                    component=component,
                    caller=_call_anthropic_sdk,
                    turn_index=turn_index,
                    runtime=runtime_for_compact,
                    session_id=self._session_id_by_instance.get(inst_id),
                )
                if result.compacted:
                    self._compaction_runs_by_instance[inst_id] = (
                        self._compaction_runs_by_instance.get(inst_id, 0) + 1
                    )
                    logger.info(
                        "[compaction] inline pre-call_llm result: pre=%d post=%d dropped=%d",
                        result.pre_count,
                        result.post_count,
                        result.messages_dropped,
                    )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[compaction] inline pass failed (continuing): %s", exc, exc_info=True)

        # Suppress tool_choice for Anthropic components — the Dapr langchaingo
        # Anthropic adapter passes tool_choice as a string ("auto") but the
        # Anthropic API expects a dict ({"type": "auto"}), causing HTTP 400.
        # Workaround: temporarily clear tool_choice for Anthropic calls.
        saved_tool_choice = None
        if component and "anthropic" in component:
            saved_tool_choice = self.execution.tool_choice
            self.execution.tool_choice = None

        sess_id = self._session_id_by_instance.get(inst_id)
        try:
            publish_session_event(
                sess_id, "llm_start", {"model": component}, instance_id=inst_id
            )
        except Exception:
            pass
        # Scope session for the inner call chain — the Anthropic adapter
        # reads this contextvar to emit agent.thinking events.
        scope_token = scope_session(sess_id, inst_id)
        try:
            self._active_llm_instance_id = inst_id
            result = super().call_llm(ctx, payload)
        except Exception as exc:
            try:
                publish_session_event(
                    sess_id, "llm_complete", {"content": "", "toolCalls": []},
                    instance_id=inst_id,
                )
            except Exception:
                pass
            raise
        finally:
            self._active_llm_instance_id = None
            unscope_session(scope_token)
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
            publish_session_event(
                sess_id,
                "llm_complete",
                {"content": content, "toolCalls": tool_calls},
                instance_id=inst_id,
            )
        except Exception:
            pass
        return result

    def run_tool(self, ctx, payload):
        """Publish tool_call_start/end streaming events with content."""
        exec_id = self._exec_id or ""
        inst_id = self._inst_id or payload.get("instance_id", "")
        sess_id = self._session_id_by_instance.get(inst_id)
        tool_call = payload.get("tool_call", {})
        tool_call_id = str(tool_call.get("id") or "") if isinstance(tool_call, dict) else ""
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

        # Telemetry: start claude_code.tool span for this activity.
        # run_tool runs as its own Dapr activity (different call from the
        # workflow body) so we re-seed session context and start a fresh
        # tool span here. tool_input is only serialized when beta tracing
        # is enabled (add_tool_input_attributes gates internally).
        _tel_session_token = None
        _tel_tool_span = None
        try:
            from src.telemetry import (
                end_tool_span,
                set_session_context,
                start_tool_span,
            )

            _tel_session_token = set_session_context(
                instance_id=inst_id,
                execution_id=exec_id,
            )
            _tool_input_json = ""
            try:
                _tool_input_json = json.dumps(tool_args)[:8192]
            except Exception:
                _tool_input_json = ""
            _tel_tool_span = start_tool_span(
                tool_name,
                tool_attributes={"tool.call_id": tool_call_id},
                tool_input=_tool_input_json,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[telemetry] tool span start failed: %s", exc)

        try:
          hook_snapshot = _current_hook_snapshot(self, inst_id)
          cwd_for_hooks = self._cwd_by_instance.get(inst_id, "") or ""
          project_dir_for_hooks = cwd_for_hooks or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
          if hooks_enabled():
            # claude_code.tool.blocked_on_user wraps PreToolUse gating — it
            # represents "tool waiting on a permission/approval decision". Ends
            # with decision=allow|deny|updated_input (mirrors TS).
            _blocked_span = None
            try:
                from src.telemetry import (
                    end_tool_blocked_on_user_span,
                    start_tool_blocked_on_user_span,
                )

                _blocked_span = start_tool_blocked_on_user_span()
            except Exception as exc:  # noqa: BLE001
                logger.warning("[telemetry] blocked_on_user start failed: %s", exc)
            _block_decision = "allow"
            try:
                pre_agg = execute_pre_tool_hooks(
                    hook_snapshot,
                    tool_name=tool_name,
                    tool_use_id=tool_call_id,
                    tool_input=tool_args,
                    session_id=inst_id,
                    cwd=cwd_for_hooks,
                    project_dir=project_dir_for_hooks,
                )
            except Exception as hook_exc:
                logger.warning("[hooks] PreToolUse error: %s", hook_exc)
                pre_agg = None
            if pre_agg is not None:
                if pre_agg.updated_input is not None:
                    tool_args = dict(pre_agg.updated_input)
                    logger.info("[hooks] PreToolUse updated input for %s", tool_name)
                    _block_decision = "updated_input"
                if pre_agg.any_block():
                    reason = pre_agg.blocking_reason or pre_agg.decision_reason or "blocked by hook"
                    logger.info("[hooks] PreToolUse blocked %s: %s", tool_name, reason)
                    _block_decision = "deny"
                    try:
                        publish_session_event(
                            sess_id,
                            "tool_call_error",
                            {
                                "toolName": tool_name,
                                "success": False,
                                "error": f"blocked by hook: {reason}"[:200],
                            },
                            source_event_id=f"{tool_call_id}:blocked" if tool_call_id else None,
                            instance_id=inst_id,
                        )
                    except Exception:
                        pass
                    blocked_msg = ToolMessage(
                        content=f"Tool {tool_name} blocked by hook: {reason}",
                        role="tool",
                        name=tool_name,
                        tool_call_id=tool_call["id"],
                    )
                    try:
                        self.text_formatter.print_message(blocked_msg)
                    except Exception:
                        pass
                    # Record code_edit_tool.decision counter for Edit/Write/NotebookEdit.
                    if tool_name in ("Edit", "Write", "NotebookEdit"):
                        try:
                            from src.telemetry import record_code_edit_decision

                            record_code_edit_decision(decision="reject", tool=tool_name)
                        except Exception:
                            pass
                    try:
                        if _blocked_span is not None:
                            end_tool_blocked_on_user_span(
                                _blocked_span,
                                decision="deny",
                                source="PreToolUse",
                            )
                    except Exception:
                        pass
                    return blocked_msg.model_dump()
            if _blocked_span is not None:
                try:
                    end_tool_blocked_on_user_span(
                        _blocked_span,
                        decision=_block_decision,
                        source="PreToolUse",
                    )
                except Exception:
                    pass
            if tool_name in ("Edit", "Write", "NotebookEdit") and _block_decision in ("allow", "updated_input"):
                try:
                    from src.telemetry import record_code_edit_decision

                    record_code_edit_decision(decision="accept", tool=tool_name)
                except Exception:
                    pass

          try:
              publish_session_event(
                  sess_id,
                  "tool_call_start",
                  {
                      "toolName": tool_name,
                      "args": {k: str(v)[:200] for k, v in (tool_args or {}).items()},
                  },
                  source_event_id=f"{tool_call_id}:start" if tool_call_id else None,
                  instance_id=inst_id,
              )
          except Exception:
              pass
          # claude_code.tool.execution wraps the actual dispatch — the MCP
          # arun() call or super().run_tool(...) — so we capture how long the
          # real work takes separately from hook/approval overhead.
          _exec_span = None
          _exec_success = False
          _exec_error: str | None = None
          try:
              from src.telemetry import (
                  end_tool_execution_span,
                  start_tool_execution_span,
              )

              _exec_span = start_tool_execution_span()
          except Exception as exc:  # noqa: BLE001
              logger.warning("[telemetry] tool.execution start failed: %s", exc)
          try:
              self._activate_instance_skills(inst_id)
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
                      _exec_error = error
                      try:
                          publish_session_event(
                              sess_id,
                              "tool_call_error",
                              {
                                  "toolName": tool_name,
                                  "success": False,
                                  "error": error[:200],
                              },
                              source_event_id=f"{tool_call_id}:error" if tool_call_id else None,
                              instance_id=inst_id,
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
                      if _exec_span is not None:
                          try:
                              end_tool_execution_span(
                                  _exec_span, success=False, error=error[:200]
                              )
                              _exec_span = None
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
              _exec_success = True
          except Exception as exc:
              _exec_error = str(exc)
              if hooks_enabled():
                  try:
                      execute_post_tool_use_failure_hooks(
                          hook_snapshot,
                          tool_name=tool_name,
                          tool_use_id=tool_call_id,
                          tool_input=tool_args,
                          error=str(exc),
                          session_id=inst_id,
                          cwd=cwd_for_hooks,
                          project_dir=project_dir_for_hooks,
                      )
                  except Exception as hook_exc:
                      logger.warning("[hooks] PostToolUseFailure error: %s", hook_exc)
              try:
                  publish_session_event(
                      sess_id,
                      "tool_call_error",
                      {
                          "toolName": tool_name,
                          "success": False,
                          "error": str(exc)[:200],
                      },
                      source_event_id=f"{tool_call_id}:error" if tool_call_id else None,
                      instance_id=inst_id,
                  )
              except Exception:
                  pass
              raise
          finally:
              if _exec_span is not None:
                  try:
                      end_tool_execution_span(
                          _exec_span,
                          success=_exec_success,
                          error=_exec_error[:200] if _exec_error else None,
                      )
                  except Exception:
                      pass
          # Extract tool output summary
          output = ""
          if isinstance(result, dict):
              raw = result.get("content", "")
              if isinstance(raw, str):
                  output = raw[:500]
          if hooks_enabled() and isinstance(result, dict):
              try:
                  post_agg = execute_post_tool_hooks(
                      hook_snapshot,
                      tool_name=tool_name,
                      tool_use_id=tool_call_id,
                      tool_input=tool_args,
                      tool_response=result.get("content"),
                      session_id=inst_id,
                      cwd=cwd_for_hooks,
                      project_dir=project_dir_for_hooks,
                  )
              except Exception as hook_exc:
                  logger.warning("[hooks] PostToolUse error: %s", hook_exc)
                  post_agg = None
              if post_agg is not None:
                  if post_agg.updated_tool_output is not None:
                      result = dict(result)
                      result["content"] = post_agg.updated_tool_output
                      output = post_agg.updated_tool_output[:500] if isinstance(post_agg.updated_tool_output, str) else output
                  elif post_agg.additional_contexts:
                      merged = dict(result)
                      suffix = "\n\n[hook context]\n" + "\n".join(post_agg.additional_contexts)
                      if isinstance(merged.get("content"), str):
                          merged["content"] = merged["content"] + suffix
                          result = merged
                          output = merged["content"][:500]
          checkpoint = None
          if should_checkpoint_tool(tool_name):
              try:
                  with _start_checkpoint_span(tool_name, tool_call_id) as _span:
                      checkpoint = capture_code_checkpoint(
                          get_runtime(),
                          execution_id=exec_id,
                          instance_id=inst_id,
                          workspace_ref=self._workspace_ref_by_instance.get(inst_id),
                          tool_call_id=tool_call_id,
                          tool_name=tool_name,
                      )
                      if _span is not None and isinstance(checkpoint, dict):
                          try:
                              _span.set_attribute("checkpoint.status", str(checkpoint.get("status") or ""))
                              _span.set_attribute("checkpoint.beforeSha", str(checkpoint.get("beforeSha") or ""))
                              _span.set_attribute("checkpoint.afterSha", str(checkpoint.get("afterSha") or ""))
                              _span.set_attribute("checkpoint.remoteStatus", str(checkpoint.get("remoteStatus") or ""))
                              _span.set_attribute("checkpoint.fileCount", int(checkpoint.get("fileCount") or 0))
                              remote_err = checkpoint.get("remoteError")
                              if remote_err:
                                  _span.set_attribute("checkpoint.remoteError", str(remote_err)[:500])
                          except Exception:
                              pass
              except Exception as exc:
                  logger.warning("[checkpoint] failed after %s: %s", tool_name, exc)
          try:
              payload: dict[str, Any] = {
                  "toolName": tool_name,
                  "success": True,
                  "output": (output or "")[:500],
              }
              if checkpoint is not None:
                  payload["codeCheckpoint"] = checkpoint
              publish_session_event(
                  sess_id,
                  "tool_call_end",
                  payload,
                  source_event_id=f"{tool_call_id}:end" if tool_call_id else None,
                  instance_id=inst_id,
              )
          except Exception:
              pass
          return result
        finally:
            # End claude_code.tool span + reset session context. Fires on every
            # exit path (successful return, exception, blocked-by-hook return).
            try:
                if _tel_tool_span is not None:
                    end_tool_span()
                from src.telemetry.attributes import reset_session_context

                if _tel_session_token is not None:
                    reset_session_context(_tel_session_token)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[telemetry] tool span end failed: %s", exc)

    @workflow_entry
    @message_router(message_model=TriggerAction)
    def agent_workflow(self, ctx, message: dict):
        if not ctx.is_replaying:
            _ac = message.get("agentConfig") if isinstance(message, dict) else None
            _mcps = (_ac or {}).get("mcpServers") if isinstance(_ac, dict) else None
            logger.info(
                "[mcp] agent_workflow entry: msg_type=%s msg_keys=%s ac_type=%s mcp_len=%s",
                type(message).__name__,
                sorted(message.keys())[:12] if isinstance(message, dict) else None,
                type(_ac).__name__,
                len(_mcps) if isinstance(_mcps, list) else (
                    "not-list" if _mcps is not None else None
                ),
            )
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
        code_checkpoint_restore = _extract_code_checkpoint_restore(message, metadata)

        if code_checkpoint_restore and not ctx.is_replaying:
            restore_result = restore_code_checkpoint(runtime, code_checkpoint_restore)
            try:
                _ctx_inst = getattr(ctx, "instance_id", None) or ""
                publish_session_event(
                    self._session_id_by_instance.get(_ctx_inst),
                    "state_snapshot",
                    {
                        "phase": "code_checkpoint_restore",
                        "success": bool(restore_result.get("ok")),
                        "codeCheckpointRestore": {
                            "checkpointId": code_checkpoint_restore.get("checkpointId"),
                            "afterSha": code_checkpoint_restore.get("afterSha"),
                            "remoteRef": code_checkpoint_restore.get("remoteRef"),
                            "repoPath": code_checkpoint_restore.get("repoPath"),
                        },
                        "result": restore_result,
                    },
                    source_event_id=f"restore:{code_checkpoint_restore.get('checkpointId') or code_checkpoint_restore.get('afterSha') or 'checkpoint'}",
                    instance_id=_ctx_inst,
                )
            except Exception:
                pass
            if not restore_result.get("ok"):
                raise RuntimeError(
                    f"Code checkpoint restore failed: {restore_result.get('error') or restore_result}"
                )
            restored_repo_path = str(code_checkpoint_restore.get("repoPath") or "").strip()
            if restored_repo_path:
                runtime.set_cwd(restored_repo_path)

        # Per-run persona override from agentConfig. Named agents carry the
        # persona inside agentConfig; apply before building the system prompt
        # so the <env> block layers on top of the right role/goal. Mirrors the
        # existing per-run override pattern for system_prompt/model/max_turns.
        agent_config = _coerce_agent_config(message.get("agentConfig")) or {}
        previous_role = self.profile.role
        previous_goal = self.profile.goal
        previous_instructions = list(self.profile.instructions or [])
        previous_style_guidelines = list(
            getattr(self.profile, "style_guidelines", None) or []
        )
        if isinstance(agent_config.get("role"), str) and agent_config["role"].strip():
            self.profile.role = agent_config["role"].strip()
        if isinstance(agent_config.get("goal"), str) and agent_config["goal"].strip():
            self.profile.goal = agent_config["goal"].strip()
        if isinstance(agent_config.get("instructions"), list):
            self.profile.instructions = [
                str(i) for i in agent_config["instructions"] if str(i).strip()
            ]
        if isinstance(agent_config.get("styleGuidelines"), list):
            style_list = [
                str(s) for s in agent_config["styleGuidelines"] if str(s).strip()
            ]
            if hasattr(self.profile, "style_guidelines"):
                self.profile.style_guidelines = style_list

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

        # Phase 4 bridge: when session_workflow spawns agent_workflow, it
        # inlines sessionId into the child's message dict. Stash per-instance
        # so activities can pass it to publish_session_event.
        session_id_raw = str(message.get("sessionId") or "").strip()
        if session_id_raw:
            self._session_id_by_instance[instance_id] = session_id_raw

        # Set telemetry session context and start interaction span (first
        # non-replay tick only). Span end + context reset happen in the
        # workflow body's `try/finally` below, also gated on non-replay.
        if not ctx.is_replaying:
            try:
                from src.telemetry import (
                    log_otel_event,
                    record_session_start,
                    set_session_context,
                    start_interaction_span,
                )

                tok = set_session_context(
                    instance_id=instance_id,
                    execution_id=execution_id,
                )
                self._interaction_ctx_token_by_instance[instance_id] = tok
                task_text = str(message.get("task") or message.get("prompt") or "")
                span = start_interaction_span(task_text)
                if span is not None:
                    self._interaction_span_by_instance[instance_id] = span
                record_session_start()
                # user_prompt event (mirrors TS processTextPrompt.ts call site).
                # Content is only included when OTEL_LOG_USER_PROMPTS=1.
                from src.telemetry.events import is_user_prompt_logging_enabled

                log_otel_event(
                    "user_prompt",
                    {
                        "prompt_length": len(task_text),
                        "prompt": task_text if is_user_prompt_logging_enabled() else "<REDACTED>",
                    },
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("[telemetry] interaction start failed: %s", exc)
        workspace_ref = str(
            message.get("workspaceRef")
            or metadata.get("workspaceRef")
            or metadata.get("workspace_ref")
            or ""
        ).strip()
        if workspace_ref:
            self._workspace_ref_by_instance[instance_id] = workspace_ref
        mcp_configs, mcp_allowed_tools = _extract_mcp_server_configs(message)
        if mcp_configs:
            self._mcp_configs_by_instance[instance_id] = mcp_configs
            self._mcp_allowed_tools_by_instance[instance_id] = mcp_allowed_tools
            logger.info(
                "[mcp] Registered %d MCP server config(s) for instance %s",
                len(mcp_configs),
                instance_id,
            )
        # Extract per-instance callable peer-agent allow-list. The TypeScript
        # resolver emits `body.callableAgents: [{slug, agentId, appId, team,
        # registryKey}, ...]` when the agent's AgentConfig.callableAgents is
        # non-empty; we stash it in a thread-local so the `call_agent` tool
        # (src/tools/call_agent) can find it when the LLM invokes it.
        try:
            from src.tools._callable_agents_context import (
                set_callable_agents_context,
            )

            raw_callable = message.get("callableAgents") or agent_config.get(
                "callableAgents"
            )
            if isinstance(raw_callable, list):
                callable_agents = [
                    item for item in raw_callable if isinstance(item, dict)
                ]
            else:
                callable_agents = []
            registry_team = (
                str(message.get("registryTeam") or "").strip()
                or str(agent_config.get("registryTeam") or "").strip()
                or None
            )
            set_callable_agents_context(
                callable_agents=callable_agents,
                registry_team=registry_team,
                parent_instance_id=instance_id,
                parent_session_id=session_id_raw or None,
            )
            if callable_agents and not ctx.is_replaying:
                logger.info(
                    "[call_agent] %d peer agent(s) available for instance %s: %s",
                    len(callable_agents),
                    instance_id,
                    ", ".join(
                        str(p.get("slug", "?")) for p in callable_agents
                    ),
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[call_agent] context setup failed: %s", exc)
        # Extract per-instance skill configs (parallel to MCP extraction)
        skill_registry = get_skill_registry()
        raw_skill_items = _extract_raw_skill_items(message)
        runtime_skill_refs = _extract_runtime_skill_refs(message)
        instance_skill_defs = (
            _install_runtime_skill_refs(runtime, instance_id, runtime_skill_refs)
            if runtime_skill_refs and not ctx.is_replaying
            else []
        )
        if not instance_skill_defs:
            instance_skill_defs = _extract_skill_configs(message)
        if instance_skill_defs:
            instance_skill_defs = _materialize_instance_skill_packages(
                runtime,
                instance_skill_defs,
                instance_id,
                raw_skill_items,
                write_files=not ctx.is_replaying,
            )
            self._skills_by_instance[instance_id] = instance_skill_defs
            skill_registry.set_instance_skills(instance_skill_defs)
            logger.info(
                "[skills] Registered %d instance skill(s) for instance %s: %s",
                len(instance_skill_defs),
                instance_id,
                ", ".join(skill.name for skill in instance_skill_defs),
            )
        elif runtime_skill_refs and ctx.is_replaying:
            cached_skill_defs = self._skills_by_instance.get(instance_id) or []
            if not cached_skill_defs:
                try:
                    cached_skill_defs = _scan_runtime_skill_install_root(
                        runtime,
                        _runtime_skill_run_dir(instance_id),
                        runtime_skill_refs,
                    )
                except Exception as exc:
                    logger.warning(
                        "[skills] Failed to re-scan runtime skills for replayed instance %s: %s",
                        instance_id,
                        exc,
                    )
            if cached_skill_defs:
                self._skills_by_instance[instance_id] = cached_skill_defs
                skill_registry.set_instance_skills(cached_skill_defs)
                logger.info(
                    "[skills] Re-activated %d cached skill(s) for replayed instance %s: %s",
                    len(cached_skill_defs),
                    instance_id,
                    ", ".join(skill.name for skill in cached_skill_defs),
                )

        # Append skill listings to system prompt so the model knows what's available
        available_skills = skill_registry.list_available()
        if available_skills:
            skill_listing_block = format_skill_listings(available_skills)
            if skill_listing_block:
                self.profile.system_prompt += "\n\n" + skill_listing_block

        if not ctx.is_replaying:
            logger.info("[exec-id] execution_id=%s instance_id=%s", execution_id, instance_id)

        # run_started is suppressed in the session stream — session_workflow's
        # session.status_running event is the canonical equivalent. No emit here.

        # Resolve per-run compaction config from agentConfig.compaction and
        # stash it on the agent so call_llm can pass it to maybe_compact.
        # This runs inside the orchestrator body; config is deterministic
        # for replay because it's derived from the trigger message which
        # is itself replayed.
        try:
            from src.compaction import resolve_config as _resolve_compaction_cfg

            self._compaction_cfg_by_instance[instance_id] = _resolve_compaction_cfg(message)
            self._compaction_call_count_by_instance.setdefault(instance_id, 0)
            self._compaction_runs_by_instance.setdefault(instance_id, 0)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[compaction] config resolution failed: %s", exc)

        # Capture per-instance hooks snapshot (overlay per-run hooks/plugins
        # from agentConfig). Pure, deterministic — safe inside the workflow fn.
        if hooks_enabled():
            effective_cwd = runtime.cwd or cwd or ""
            self._cwd_by_instance[instance_id] = effective_cwd
            try:
                base_snap = getattr(self, "_base_hooks_snapshot", None) or empty_snapshot()
                per_run_snap = _apply_per_run_hooks(
                    base_snap,
                    message,
                    plugin_registry=getattr(self, "_plugin_registry", None),
                )
                _install_hook_snapshot(self, instance_id, per_run_snap)
            except Exception as exc:
                logger.warning("[hooks] failed to build per-instance snapshot: %s", exc)

            # SessionStart + UserPromptSubmit hooks — fire on first execution only.
            # Follows the same non-durable pattern as PLAN.md injection above.
            if not ctx.is_replaying:
                snap = _current_hook_snapshot(self, instance_id)
                project_dir_hook = runtime.cwd or cwd or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
                try:
                    start_agg = execute_session_start_hooks(
                        snap,
                        source="startup",
                        session_id=instance_id,
                        cwd=runtime.cwd or cwd or "",
                        project_dir=project_dir_hook,
                    )
                    if start_agg.additional_contexts:
                        self.profile.system_prompt += "\n\n" + "\n\n".join(
                            start_agg.additional_contexts
                        )
                    if start_agg.initial_user_message and isinstance(message.get("task"), str):
                        message = {
                            **message,
                            "task": start_agg.initial_user_message + "\n\n" + str(message.get("task") or ""),
                        }
                    if start_agg.any_block():
                        raise RuntimeError(
                            f"SessionStart hook blocked workflow: "
                            f"{start_agg.blocking_reason or start_agg.decision_reason or 'blocked'}"
                        )
                except RuntimeError:
                    raise
                except Exception as exc:
                    logger.warning("[hooks] SessionStart error: %s", exc)

                prompt_text = str(message.get("task") or message.get("prompt") or "")
                if prompt_text:
                    try:
                        submit_agg = execute_user_prompt_submit_hooks(
                            snap,
                            prompt=prompt_text,
                            session_id=instance_id,
                            cwd=runtime.cwd or cwd or "",
                            project_dir=project_dir_hook,
                        )
                        if submit_agg.additional_contexts:
                            message = {
                                **message,
                                "task": (message.get("task") or "")
                                + "\n\n"
                                + "\n\n".join(submit_agg.additional_contexts),
                            }
                        if submit_agg.any_block():
                            raise RuntimeError(
                                f"UserPromptSubmit hook blocked workflow: "
                                f"{submit_agg.blocking_reason or submit_agg.decision_reason or 'blocked'}"
                            )
                    except RuntimeError:
                        raise
                    except Exception as exc:
                        logger.warning("[hooks] UserPromptSubmit error: %s", exc)

        agent_workflow_result = None
        try:
            # In dapr-agents 1.0.1 the base agent_workflow generator returns
            # the final assistant message via `return final_message`.
            # `yield from` evaluates to the subgenerator's return value, so
            # capture it; session_workflow relies on it flowing out as the
            # per-turn result (and CallAgent's tool_result content ultimately
            # comes from this dict's "content" field).
            agent_workflow_result = yield from super().agent_workflow(ctx, message)

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
                    publish_session_event(
                        self._session_id_by_instance.get(instance_id),
                        "plan_artifact",
                        {"content": plan_content, "file": "PLAN.md"},
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

            # Scan /mnt/session/outputs/* and ship each file to the Files API
            # with purpose=output, scopeId=<session_id>. Gated on session_id
            # presence (no-op for standalone agent_workflow runs without a
            # session) and on `not ctx.is_replaying` so Dapr replay doesn't
            # produce duplicate file rows. Failures are logged and don't
            # affect the workflow result.
            session_id_for_outputs = self._session_id_by_instance.get(instance_id)
            if session_id_for_outputs and not ctx.is_replaying:
                try:
                    summary = _scan_session_outputs(session_id_for_outputs, runtime)
                    logger.info(
                        "[session-outputs] %s scan summary: %s",
                        session_id_for_outputs,
                        summary,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "[session-outputs] scan failed for %s: %s",
                        session_id_for_outputs,
                        exc,
                    )

            if hooks_enabled() and not ctx.is_replaying:
                try:
                    snap = _current_hook_snapshot(self, instance_id)
                    project_dir_hook = runtime.cwd or cwd or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
                    stop_agg = execute_stop_hooks(
                        snap,
                        session_id=instance_id,
                        cwd=runtime.cwd or cwd or "",
                        project_dir=project_dir_hook,
                    )
                    if stop_agg.any_block():
                        logger.info(
                            "[hooks] Stop hook returned block (advisory in v1): %s",
                            stop_agg.blocking_reason or stop_agg.decision_reason or "",
                        )
                except Exception as exc:
                    logger.warning("[hooks] Stop error: %s", exc)
            # run_complete is suppressed — session_workflow emits
            # session.status_idle when the agent finishes cleanly.
            if hooks_enabled() and not ctx.is_replaying:
                try:
                    snap = _current_hook_snapshot(self, instance_id)
                    project_dir_hook = runtime.cwd or cwd or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
                    execute_session_end_hooks(
                        snap,
                        reason="other",
                        session_id=instance_id,
                        cwd=runtime.cwd or cwd or "",
                        project_dir=project_dir_hook,
                    )
                except Exception as exc:
                    logger.warning("[hooks] SessionEnd (success) error: %s", exc)
            self._close_mcp_client(instance_id)
        except Exception as exc:
            # run_error is suppressed — session_workflow emits session.status_errored
            # with stop_reason carrying the full error context.
            _ = exc  # retained for re-raise below
            if hooks_enabled() and not ctx.is_replaying:
                try:
                    snap = _current_hook_snapshot(self, instance_id)
                    project_dir_hook = runtime.cwd or cwd or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
                    execute_session_end_hooks(
                        snap,
                        reason="errored",
                        session_id=instance_id,
                        cwd=runtime.cwd or cwd or "",
                        project_dir=project_dir_hook,
                    )
                except Exception as hook_exc:
                    logger.warning("[hooks] SessionEnd (error) error: %s", hook_exc)
            self._close_mcp_client(instance_id)
            raise
        finally:
            # NOTE: finally fires on every Dapr orchestrator replay yield-point,
            # not just on true workflow completion. We used to pop per-instance
            # caches here, but that erased per-run hook snapshots + compaction
            # config BEFORE the next activity could read them. Leave the caches
            # intact; each replay's install/resolve block rewrites the entries
            # idempotently, so the memory footprint is bounded by the number of
            # concurrently-live workflow instances.
            self.execution.max_iterations = previous_max_iterations
            self.llm._llm_component = previous_component
            self.profile.system_prompt = previous_system_prompt
            self.profile.role = previous_role
            self.profile.goal = previous_goal
            self.profile.instructions = previous_instructions
            if hasattr(self.profile, "style_guidelines"):
                self.profile.style_guidelines = previous_style_guidelines
            skill_registry.clear_instance_skills()
            # End the claude_code.interaction span + reset session context.
            # Gated on non-replay to avoid prematurely closing the span every
            # orchestrator replay tick (see comment above on finally semantics).
            if not ctx.is_replaying and instance_id in self._interaction_span_by_instance:
                try:
                    from src.telemetry import end_interaction_span
                    from src.telemetry.attributes import reset_session_context

                    end_interaction_span()
                    self._interaction_span_by_instance.pop(instance_id, None)
                    tok = self._interaction_ctx_token_by_instance.pop(
                        instance_id, None
                    )
                    if tok is not None:
                        try:
                            reset_session_context(tok)
                        except Exception:
                            pass
                except Exception as exc:  # noqa: BLE001
                    logger.warning("[telemetry] interaction end failed: %s", exc)

        return agent_workflow_result

    # ------------------------------------------------------------------
    # Session workflow (CMA-shape multi-turn loop)
    # ------------------------------------------------------------------

    def register_workflows(self, runtime) -> None:
        """Extend the base registration so `session_workflow` is visible to
        the Dapr workflow runtime alongside `agent_workflow` and
        `broadcast_listener`. Without this override, the base hard-codes
        only its two workflows and session_workflow instances fail
        immediately (worker has no entry in the registry).

        Also registers Approach-B peer-invocation machinery:
        `call_peer_session_workflow` (wrapper) and `create_peer_session_row`
        (activity). Both are no-ops unless the parent agent's LLM emits a
        CallAgent tool_call via the native workflow-tool path.
        """
        super().register_workflows(runtime)
        runtime.register_workflow(self.session_workflow)
        runtime.register_workflow(self.call_peer_session_workflow)
        runtime.register_activity(self.create_peer_session_row)

    @workflow_entry
    def call_peer_session_workflow(self, ctx, message: dict):
        """Two-step peer-delegation wrapper for Approach B.

        Input (built by CallAgentWorkflowTool):
            {
              sessionId: "ca-<uuid>-<slug>",  # deterministic, ≤64 chars
              peerAgentId, peerSlug,
              prompt,
              parentSessionId, parentInstanceId, registryTeam,
            }

        Flow:
          1. yield create_peer_session_row activity
             → BFF creates the `sessions` row (idempotent by sessionId)
             → activity returns resolved {agentConfig, environmentConfig,
                vaultIds, callableAgents, registryTeam}
          2. yield session_workflow as a child, passing that childInput +
             the user prompt as initialEvents + autoTerminate=true.
          3. Return the child's result dict so the parent agent_workflow's
             CallAgent tool_result carries the peer's final content back
             to the LLM in the same turn.

        Every yield is Dapr event-sourced. Deterministic `sessionId`
        ensures retries re-attach to the same row + same session_workflow
        instance rather than double-spawning.
        """
        row = yield ctx.call_activity(
            self.create_peer_session_row,
            input=message,
        )
        if not isinstance(row, dict) or not row.get("sessionId"):
            raise RuntimeError(
                f"create_peer_session_row returned unexpected payload: {row!r}"
            )
        session_id = row["sessionId"]
        # The wrapper workflow's own Dapr instance_id IS session_id
        # (CallAgentWorkflowTool passes the same deterministic value).
        # We must NOT reuse it for session_workflow — Dapr keys workflow
        # instances by id, and collision causes the dispatcher to replay
        # both orchestrators against the same event stream (seen as
        # "Ignoring unexpected taskCompleted event" warnings + the child
        # stuck in "rescheduling"). Suffix with `:swf` so the inner
        # session_workflow gets its own instance while sessions.id /
        # NATS subject / event-log keys remain `session_id`. 64-char
        # Dapr cap budget: ≤40 chars for base + 4 for suffix = 44.
        swf_instance_id = f"{session_id}:swf"
        child_result = yield ctx.call_child_workflow(
            "session_workflow",
            input={
                "sessionId": session_id,
                "agentConfig": row.get("agentConfig") or {},
                "environmentConfig": row.get("environmentConfig") or {},
                "vaultIds": row.get("vaultIds") or [],
                "callableAgents": row.get("callableAgents") or [],
                "registryTeam": row.get("registryTeam"),
                "initialEvents": [
                    {
                        "type": "user.message",
                        "content": [
                            {"type": "text", "text": str(message.get("prompt") or "")}
                        ],
                    }
                ],
                "autoTerminateAfterEndTurn": True,
            },
            instance_id=swf_instance_id,
        )
        # session_workflow returns a dict with content/success/sessionId/turn.
        # Pass it through verbatim — the SDK serializes this as the CallAgent
        # tool's tool_result content, which the parent LLM sees directly.
        result = (
            child_result
            if isinstance(child_result, dict)
            else {"content": str(child_result or "")}
        )
        result.setdefault("sessionId", session_id)
        result.setdefault("peerSlug", message.get("peerSlug"))
        return result

    def create_peer_session_row(self, ctx, payload: dict) -> dict:
        """Activity: POST /api/internal/sessions/spawn-peer?skipSpawn=true
        to create (or fetch, if replayed) the peer's session row +
        pre-resolve the agentConfig / environmentConfig / callableAgents
        block so `call_peer_session_workflow` can spawn session_workflow
        without a second BFF round-trip.

        Idempotent: the BFF endpoint keys on the deterministic sessionId
        and short-circuits if the row already exists. Safe under activity
        retry.
        """
        import urllib.error
        import urllib.request

        session_id = str(payload.get("sessionId") or "").strip()
        peer_agent_id = str(payload.get("peerAgentId") or "").strip()
        if not session_id or not peer_agent_id:
            raise ValueError(
                "create_peer_session_row requires sessionId + peerAgentId"
            )

        token = os.environ.get("INTERNAL_API_TOKEN", "").strip()
        if not token:
            raise RuntimeError(
                "INTERNAL_API_TOKEN not configured on dapr-agent-py"
            )
        app_id = os.environ.get("WORKFLOW_BUILDER_APP_ID", "workflow-builder")
        dapr_http = os.environ.get("DAPR_HTTP_PORT", "3500")
        url = (
            f"http://localhost:{dapr_http}/v1.0/invoke/{app_id}"
            "/method/api/internal/sessions/spawn-peer"
        )
        body = {
            "sessionId": session_id,
            "peerAgentId": peer_agent_id,
            "prompt": payload.get("prompt") or "",
            "parentSessionId": payload.get("parentSessionId"),
            "parentInstanceId": payload.get("parentInstanceId"),
            "title": payload.get("title"),
            "skipSpawn": True,
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Internal-Token": token,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                text = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:400]
            raise RuntimeError(
                f"spawn-peer rejected (HTTP {exc.code}): {detail}"
            ) from exc
        try:
            return json.loads(text)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                f"spawn-peer returned non-JSON: {text[:200]!r}"
            ) from exc

    @workflow_entry
    def session_workflow(self, ctx, message: dict):
        """Multi-turn session loop wrapping ``agent_workflow`` as a child
        workflow per turn. Mirrors the Claude Managed Agents session
        primitive — stays alive across many user events via Dapr's
        ``wait_for_external_event`` pattern.

        Input shape::

            {
                "sessionId": "sesn_abc",
                "agentConfig": { ... },       # resolved by SvelteKit BFF
                "environmentConfig": { ... }, # resolved by SvelteKit BFF
                "vaultIds": [...],
                "initialEvents": [            # optional kickoff batch
                    {"type": "user.message", "content": [{"type":"text","text":"..."}]}
                ],
                "dbExecutionId": "...",       # optional workflow-execution correlation
            }

        The workflow does NOT handle permission policies or custom tools in
        v1 — those surface as normal tool calls inside ``agent_workflow``.
        The session-level loop adds: kickoff, multi-turn conversation,
        interrupt (via external event), graceful terminate.
        """
        session_id = str(message.get("sessionId") or "")
        if not session_id:
            raise RuntimeError("session_workflow requires sessionId")

        # Stamp the process-local runtime with the current session id so
        # tools like ReadSessionEvents can scope reads to this session
        # without the agent having to pass the id explicitly. Safe on
        # replay: this is just in-memory state that gets reset per
        # workflow entry.
        get_runtime().set_session_id(session_id)

        agent_cfg = _coerce_agent_config(message.get("agentConfig")) or {}
        env_cfg = message.get("environmentConfig") or {}
        vault_ids = message.get("vaultIds") or []
        db_execution_id = str(message.get("dbExecutionId") or "")
        pending = list(message.get("initialEvents") or [])
        # Workflow-bridge mode: when an orchestrator calls session_workflow as
        # a child workflow for a `durable/run` node, it wants a single-turn
        # request/response shape — spawn, run the initial turn, return the
        # result, and self-terminate. UI-initiated sessions leave this unset
        # so the multi-turn loop continues across user events.
        auto_terminate = bool(message.get("autoTerminateAfterEndTurn"))

        if not ctx.is_replaying:
            publish_session_event(
                session_id,
                "session.status_rescheduled",
                {"vaultIds": vault_ids},
            )

        turn_counter = 0
        while True:
            if not pending:
                if not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.status_idle",
                        {"stop_reason": {"type": "end_turn"}},
                    )
                try:
                    batch = yield ctx.wait_for_external_event("session.user_events")
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "[session] %s wait_for_external_event failed: %s",
                        session_id,
                        exc,
                    )
                    break
                pending = list((batch or {}).get("events") or [])
                if not pending:
                    continue

            if any(ev.get("type") == "session.terminate" for ev in pending):
                if not ctx.is_replaying:
                    publish_session_event(session_id, "session.status_terminated", {})
                return

            # Extract the user.message text(s) + tool_confirmations / custom_tool_results.
            # For v1 we join all text content into a single "task" string; the
            # other event types pass through as context strings so agent_workflow
            # can see them in its prompt.
            task_text = _compose_turn_task(pending)
            pending = []
            turn_counter += 1

            if not ctx.is_replaying:
                publish_session_event(
                    session_id,
                    "session.status_running",
                    {"turn": turn_counter},
                )

            # Build the child workflow input — same shape agent_workflow accepts.
            child_input = _freeze_session_child_input(
                session_id=session_id,
                agent_cfg=agent_cfg,
                env_cfg=env_cfg,
                vault_ids=vault_ids,
                db_execution_id=db_execution_id,
                turn=turn_counter,
                task=task_text,
                raw_message=message,
            )

            try:
                # Apply the same retry policy agent_workflow uses internally
                # (WorkflowRetryPolicy(max_attempts=8, 4s→45s backoff) — see
                # the DurableAgent instantiation below). Without this, an
                # agent_workflow turn that exhausts its internal retries
                # would terminate the session with a single session.error
                # event. Matching policy lets session_workflow retry the
                # whole turn on transient agent-side failures, consistent
                # with Dapr-native durability semantics for workflow-driven
                # runs (Deploy A of the CMA-alignment plan).
                # In dapr-agents 1.0.1 the base class registers
                # agent_workflow under a namespaced name
                # (dapr.agents.<AgentName>.workflow) via _named(); the
                # bare "agent_workflow" string is no longer in the
                # runtime registry. Use the property the SDK exposes for
                # cross-workflow dispatch so this keeps working even if
                # the naming scheme changes again.
                turn_result = yield ctx.call_child_workflow(
                    self.agent_workflow_name,
                    input=child_input,
                    instance_id=f"{session_id}:turn-{turn_counter}",
                    retry_policy=self._retry_policy,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[session] %s turn %d failed: %s",
                    session_id,
                    turn_counter,
                    exc,
                )
                if not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.error",
                        {"turn": turn_counter, "error": str(exc)[:500]},
                    )
                    publish_session_event(
                        session_id,
                        "session.status_terminated",
                        {},
                    )
                if auto_terminate:
                    return {
                        "success": False,
                        "content": str(exc)[:500],
                        "error": str(exc)[:500],
                        "sessionId": session_id,
                        "turn": turn_counter,
                    }
                return

            # Workflow-bridge path: return the child's result to the parent
            # orchestrator and self-terminate. UI sessions skip this branch
            # and loop back to await the next user event.
            if auto_terminate:
                if not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.status_idle",
                        {"stop_reason": {"type": "end_turn"}},
                    )
                    publish_session_event(
                        session_id,
                        "session.status_terminated",
                        {"reason": "auto_terminate_after_end_turn"},
                    )
                result_dict = (
                    turn_result
                    if isinstance(turn_result, dict)
                    else {"content": str(turn_result or "")}
                )
                result_dict.setdefault("success", not bool(result_dict.get("error")))
                result_dict.setdefault("sessionId", session_id)
                result_dict.setdefault("turn", turn_counter)
                return result_dict


def _compose_turn_task(events: list[dict]) -> str:
    """Collapse a batch of user events into a single task string that
    agent_workflow can consume. ``user.message`` text blocks concatenate;
    tool confirmations and custom-tool results append as bracketed notes.
    """
    parts: list[str] = []
    for ev in events:
        et = ev.get("type") or ""
        if et == "user.message":
            content = ev.get("content") or ev.get("data", {}).get("content") or []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text = str(block.get("text") or "")
                    if text:
                        parts.append(text)
        elif et == "user.tool_confirmation":
            result = ev.get("result") or ev.get("data", {}).get("result")
            tool_use_id = ev.get("tool_use_id") or ev.get("data", {}).get("tool_use_id")
            parts.append(
                f"[tool_confirmation tool_use_id={tool_use_id} result={result}]"
            )
        elif et == "user.custom_tool_result":
            tool_use_id = ev.get("tool_use_id") or ev.get("data", {}).get("tool_use_id")
            content = ev.get("content") or ev.get("data", {}).get("content") or []
            text = "".join(
                str(b.get("text") or "") for b in content if isinstance(b, dict)
            )
            parts.append(
                f"[custom_tool_result tool_use_id={tool_use_id}] {text}"
            )
    return "\n\n".join(parts)


def _freeze_session_child_input(
    *,
    session_id: str,
    agent_cfg: dict,
    env_cfg: dict,
    vault_ids: list,
    db_execution_id: str,
    turn: int,
    task: str,
    raw_message: dict,
) -> dict:
    """Build the frozen input payload for a per-turn agent_workflow child
    call. Reuses the message shape that sw_workflow already passes through,
    so the existing agent_workflow code path is untouched.
    """
    # Sandbox plumbing — copy through whatever the BFF baked into the
    # session-start message; environmentConfig overrides for future turns.
    sandbox_policy = (env_cfg or {}).get("sandboxPolicy") or raw_message.get(
        "sandboxPolicy"
    )
    sandbox_name = raw_message.get("sandboxName") or ""
    workspace_ref = raw_message.get("workspaceRef") or ""
    cwd = raw_message.get("cwd") or "/sandbox"

    # call_agent plumbing: spawn.ts (SvelteKit BFF) enriches the raw
    # session-start payload with `callableAgents` (full {slug, agentId,
    # appId, team, registryKey} metadata) + `registryTeam` (the team
    # string used to key Dapr registry entries). Forward both so the
    # child agent_workflow can stash them in the call_agent thread-local.
    callable_agents = raw_message.get("callableAgents") or []
    registry_team = raw_message.get("registryTeam") or None
    return {
        "task": task,
        "prompt": task,
        "sessionId": session_id,
        "executionId": db_execution_id,
        "dbExecutionId": db_execution_id,
        "workflowExecutionId": db_execution_id,
        "agentConfig": agent_cfg,
        "vaultIds": vault_ids,
        "sandboxPolicy": sandbox_policy,
        "sandboxName": sandbox_name,
        "workspaceRef": workspace_ref,
        "cwd": cwd,
        "callableAgents": callable_agents,
        "registryTeam": registry_team,
        "_session_turn": turn,
        "_message_metadata": {
            "executionId": db_execution_id,
            "sessionId": session_id,
            "turn": turn,
        },
    }


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
    # Retry window widened from the dapr-agents default (~24s across 3
    # attempts) to ~140s across 8 attempts. Covers pod restart + image
    # pull + Dapr sidecar handshake when a worker dies mid-activity.
    # Layer A (anthropic max_retries=4) absorbs sub-5s blips SDK-internally;
    # this policy covers the longer pod-death window.
    retry_policy=WorkflowRetryPolicy(
        max_attempts=8,
        initial_backoff_seconds=4,
        max_backoff_seconds=45,
        backoff_multiplier=1.5,
    ),
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

# Wire hooks + plugins. Safe to call even when feature flags are off —
# the attributes are attached with empty registries so downstream code
# can touch them unconditionally.
try:
    _bootstrap_hooks_and_plugins(agent)
except Exception as exc:
    logger.warning("Hooks/plugins bootstrap failed: %s", exc)


def _notification_hook_dispatcher(
    event_type: str,
    data: dict[str, Any],
    execution_id: str | None,
    instance_id: str | None,
) -> None:
    """Fire Notification hooks for eligible publisher events.

    Runs on a daemon thread (see event_publisher). Not part of the
    durable workflow contract — Notification hooks are advisory.
    """
    if not hooks_enabled():
        return
    instance_key = instance_id or ""
    try:
        snapshot = _current_hook_snapshot(agent, instance_key)
    except Exception:
        snapshot = getattr(agent, "_base_hooks_snapshot", None) or empty_snapshot()
    if snapshot is None or not snapshot.by_event:
        return
    message = str(data.get("error") or data.get("output") or data.get("message") or event_type)
    execute_notification_hooks(
        snapshot,
        message=message,
        session_id=instance_key,
        cwd=agent._cwd_by_instance.get(instance_key, "") if hasattr(agent, "_cwd_by_instance") else "",
        project_dir=os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd(),
        title=event_type,
        notification_type=event_type,
    )


try:
    from src.event_publisher import set_notification_dispatcher

    set_notification_dispatcher(_notification_hook_dispatcher)
except Exception as exc:
    logger.warning("Notification dispatcher wiring failed: %s", exc)

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

try:
    from src.openai_adapter import patch_for_openai
    patch_for_openai(agent.llm)
except Exception as exc:
    logger.warning("OpenAI adapter patch failed: %s", exc)

runner = AgentRunner()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("%s starting", AGENT_SERVICE_NAME)
    yield
    logger.info("%s shutting down", AGENT_SERVICE_NAME)
    runner.shutdown(agent)
    try:
        from src.telemetry import shutdown_telemetry

        shutdown_telemetry()
    except Exception as exc:
        logger.warning("Telemetry shutdown failed: %s", exc)


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


class AgentRunHistoryEventResponse(BaseModel):
    eventId: int | None = None
    eventType: str
    timestamp: str | None = None
    name: str | None = None
    input: Any = None
    output: Any = None
    metadata: dict[str, Any] | None = None
    raw: dict[str, Any] | None = None


class AgentRunHistoryResponse(BaseModel):
    instanceId: str
    events: list[AgentRunHistoryEventResponse]


class RerunAgentRunRequest(BaseModel):
    fromEventId: int = Field(
        default=0,
        description="Durable history event ID to replay from. 0 replays from start.",
    )
    newInstanceId: str | None = Field(
        default=None,
        description="Optional explicit Dapr instance ID for the replay.",
    )
    input: Any = Field(
        default=None,
        description="Replacement input sent only when overwriteInput is true.",
    )
    overwriteInput: bool = Field(
        default=False,
        description="Pass replacement input to Dapr RerunWorkflowFromEvent.",
    )
    reason: str | None = None


class TerminateAgentRunRequest(BaseModel):
    reason: str | None = None


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


def _normalize_history_event(event: Any) -> dict[str, Any]:
    """Normalize a durabletask HistoryEvent protobuf object for Workflow Ops."""
    from google.protobuf.json_format import MessageToDict

    payload_name = "unknown"
    payload = None
    for field_descriptor, value in event.ListFields():
        if field_descriptor.name in ("eventId", "timestamp", "router"):
            continue
        payload_name = field_descriptor.name
        payload = value
        break

    payload_dict = (
        MessageToDict(payload, preserving_proto_field_name=True)
        if payload is not None
        else {}
    )

    name_value = None
    for key in ("name", "event_name", "instance_id", "task_execution_id", "task_scheduled_id"):
        value = payload_dict.get(key)
        if isinstance(value, (str, int)):
            name_value = str(value)
            break

    input_value = payload_dict.get("input")
    if isinstance(input_value, dict):
        input_value = input_value.get("value", input_value)
    output_value = payload_dict.get("result")
    if isinstance(output_value, dict):
        output_value = output_value.get("value", output_value)
    if output_value is None and "failure_details" in payload_dict:
        output_value = payload_dict.get("failure_details")

    metadata: dict[str, Any] = {}
    if "orchestration_status" in payload_dict:
        metadata["status"] = _runtime_status_name(payload_dict["orchestration_status"])
    task_id = payload_dict.get("task_scheduled_id") or payload_dict.get("task_execution_id")
    if isinstance(task_id, (str, int)):
        metadata["taskId"] = str(task_id)
    failure_details = payload_dict.get("failure_details")
    if isinstance(failure_details, dict):
        error_message = failure_details.get("error_message")
        if isinstance(error_message, str) and error_message:
            metadata["error"] = error_message
        stack_trace = failure_details.get("stack_trace")
        if isinstance(stack_trace, dict):
            stack_trace = stack_trace.get("value")
        if isinstance(stack_trace, str) and stack_trace:
            metadata["stackTrace"] = stack_trace
    rerun_parent = payload_dict.get("rerun_parent_instance_info")
    if isinstance(rerun_parent, dict):
        source_instance_id = rerun_parent.get("instance_id")
        if isinstance(source_instance_id, str) and source_instance_id:
            metadata["rerunSourceInstanceId"] = source_instance_id
    version_value = payload_dict.get("version")
    if isinstance(version_value, dict):
        version_value = version_value.get("value")
    if isinstance(version_value, str) and version_value:
        metadata["version"] = version_value

    timestamp = None
    if hasattr(event, "timestamp") and event.HasField("timestamp"):
        timestamp = event.timestamp.ToDatetime().isoformat()

    event_id = int(event.eventId) if getattr(event, "eventId", 0) > 0 else None
    event_type = payload_name[0:1].upper() + payload_name[1:]

    return {
        "eventId": event_id,
        "eventType": event_type,
        "timestamp": timestamp,
        "name": name_value,
        "input": _parse_json(input_value),
        "output": _parse_json(output_value),
        "metadata": metadata or None,
        "raw": payload_dict or None,
    }


def _get_instance_history(instance_id: str) -> list[dict[str, Any]]:
    import durabletask.internal.orchestrator_service_pb2 as pb

    response = _taskhub_call(
        "GetInstanceHistory",
        pb.GetInstanceHistoryRequest(instanceId=instance_id),
    )
    return [_normalize_history_event(event) for event in response.events]


def _build_agent_run_status_payload(instance_id: str) -> dict[str, Any] | None:
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

    error_value = None
    if isinstance(workflow_record.get("error"), str):
        error_value = workflow_record.get("error")
    elif isinstance(output_payload, dict) and isinstance(output_payload.get("error"), str):
        error_value = output_payload.get("error")

    return {
        "instanceId": instance_id,
        "appId": AGENT_SERVICE_NAME,
        "workflowId": "agent_workflow",
        "workflowName": AGENT_SERVICE_NAME,
        "runtimeStatus": runtime_status,
        "phase": runtime_status.lower(),
        "startedAt": started_at,
        "completedAt": completed_at or (last_updated_at if _terminal_status(runtime_status) else None),
        "input": input_payload,
        "outputs": output_payload,
        "error": error_value,
        "messages": workflow_record.get("messages") or [],
        "toolHistory": workflow_record.get("tool_history") or [],
        "memory": memory_state,
        "stateKey": workflow_state_key,
        "memoryKey": memory_key,
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


@app.get("/api/v2/agent-runs/{instance_id}/status")
def get_agent_run_status(instance_id: str) -> dict[str, Any]:
    try:
        payload = _build_agent_run_status_payload(instance_id)
        if payload is None:
            raise HTTPException(status_code=404, detail="Agent run not found")
        return payload
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[agent-runs] Failed to get status for %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/v2/agent-runs/{instance_id}/history", response_model=AgentRunHistoryResponse)
def get_agent_run_history(instance_id: str) -> AgentRunHistoryResponse:
    import durabletask.internal.orchestrator_service_pb2 as pb

    try:
        response = _taskhub_call(
            "GetInstance",
            pb.GetInstanceRequest(instanceId=instance_id, getInputsAndOutputs=False),
        )
        if not getattr(response, "exists", False):
            raise HTTPException(status_code=404, detail="Agent run not found")
        events = _get_instance_history(instance_id)
        events.sort(key=lambda item: str(item.get("timestamp") or ""), reverse=True)
        return AgentRunHistoryResponse(
            instanceId=instance_id,
            events=[AgentRunHistoryEventResponse(**event) for event in events],
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[agent-runs] Failed to get history for %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v2/agent-runs/{instance_id}/rerun")
def rerun_agent_run(
    instance_id: str,
    request: RerunAgentRunRequest = RerunAgentRunRequest(),
) -> dict[str, Any]:
    import durabletask.internal.orchestrator_service_pb2 as pb

    try:
        response = _taskhub_call(
            "GetInstance",
            pb.GetInstanceRequest(instanceId=instance_id, getInputsAndOutputs=False),
        )
        if not getattr(response, "exists", False):
            raise HTTPException(status_code=404, detail="Agent run not found")

        event_id = max(0, int(request.fromEventId))
        rerun_request = pb.RerunWorkflowFromEventRequest(
            sourceInstanceID=instance_id,
            eventID=event_id,
        )
        new_instance_id = str(request.newInstanceId or "").strip()
        if new_instance_id:
            rerun_request.newInstanceID = new_instance_id
        if request.overwriteInput:
            rerun_request.overwriteInput = True
            rerun_request.input.CopyFrom(
                wrappers_pb2.StringValue(
                    value=json.dumps(jsonable_encoder(request.input)),
                )
            )

        rerun_response = _taskhub_call("RerunWorkflowFromEvent", rerun_request)
        actual_new_instance_id = str(getattr(rerun_response, "newInstanceID", "") or "")
        if not actual_new_instance_id:
            raise RuntimeError("Rerun succeeded but no newInstanceID was returned")

        logger.info(
            "[agent-runs] Rerun scheduled: source=%s event_id=%s new=%s reason=%s",
            instance_id,
            event_id,
            actual_new_instance_id,
            request.reason,
        )
        return {
            "success": True,
            "sourceInstanceId": instance_id,
            "fromEventId": event_id,
            "newInstanceId": actual_new_instance_id,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[agent-runs] Failed to rerun %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v2/agent-runs/{instance_id}/terminate")
def terminate_agent_run(
    instance_id: str,
    request: TerminateAgentRunRequest = TerminateAgentRunRequest(),
) -> dict[str, Any]:
    try:
        from dapr.ext.workflow import DaprWorkflowClient

        DaprWorkflowClient().terminate_workflow(
            instance_id=instance_id,
            output=request.reason,
        )
        return {"success": True, "instanceId": instance_id}
    except Exception as exc:
        logger.error("[agent-runs] Failed to terminate %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v2/agent-runs/{instance_id}/pause")
def pause_agent_run(instance_id: str) -> dict[str, Any]:
    try:
        from dapr.ext.workflow import DaprWorkflowClient

        DaprWorkflowClient().suspend_workflow(instance_id=instance_id)
        return {"success": True, "instanceId": instance_id}
    except Exception as exc:
        logger.error("[agent-runs] Failed to pause %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/v2/agent-runs/{instance_id}/resume")
def resume_agent_run(instance_id: str) -> dict[str, Any]:
    try:
        from dapr.ext.workflow import DaprWorkflowClient

        DaprWorkflowClient().resume_workflow(instance_id=instance_id)
        return {"success": True, "instanceId": instance_id}
    except Exception as exc:
        logger.error("[agent-runs] Failed to resume %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.delete("/api/v2/agent-runs/{instance_id}")
def purge_agent_run(
    instance_id: str,
    force: bool = False,
    recursive: bool = False,
) -> dict[str, Any]:
    import durabletask.internal.orchestrator_service_pb2 as pb

    try:
        purge_response = _taskhub_call(
            "PurgeInstances",
            pb.PurgeInstancesRequest(
                instanceId=instance_id,
                recursive=recursive,
                force=force,
            ),
        )
        return {
            "success": True,
            "instanceId": instance_id,
            "force": force,
            "recursive": recursive,
            "deletedInstanceCount": int(getattr(purge_response, "deletedInstanceCount", 0) or 0),
            "isComplete": bool(getattr(getattr(purge_response, "isComplete", None), "value", True)),
        }
    except Exception as exc:
        logger.error("[agent-runs] Failed to purge %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


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


@app.post("/internal/sessions/spawn")
def spawn_session_endpoint(request: dict) -> dict:
    """Start a session_workflow instance on this sidecar (Phase 4 bridge).

    The BFF can't invoke the Dapr workflow HTTP API cross-app via
    placement — actor routing requires the workflow runtime to be
    registered on the initiating sidecar, and workflow-builder has
    none. Instead the BFF service-invokes this endpoint, and the call
    runs on dapr-agent-py's own sidecar which owns session_workflow.

    Body: { instanceId: str, payload: dict }
    """
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
        # StartInstance errors on duplicate instanceId — treat as idempotent.
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
    import durabletask.internal.orchestrator_service_pb2 as pb

    instance_id = str(request.get("instanceId") or "").strip()
    event_name = str(request.get("eventName") or "").strip()
    payload = request.get("payload") or {}
    if not instance_id or not event_name:
        raise HTTPException(status_code=400, detail="instanceId + eventName required")

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


@app.get("/healthz")
async def health_check() -> dict:
    return {"status": "healthy", "service": AGENT_SERVICE_NAME}


@app.get("/readyz")
async def readiness_check() -> dict:
    return {"status": "ready", "service": AGENT_SERVICE_NAME}
