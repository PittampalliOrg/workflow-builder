"""Per-turn effective agent configuration snapshots.

The snapshot is execution provenance, not a clone of the mutable AgentConfig.
It intentionally keeps only compact, durable identifiers for agent, llm,
execution, and tools. Prompts, auth headers, env vars, vault values, and tool
schemas are excluded by construction.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any, Mapping


EFFECTIVE_AGENT_CONFIG_SCHEMA_VERSION = "workflow-builder.effective-agent-config.v1"


MODEL_COMPONENT_MAP: dict[str, str] = {
    # Anthropic
    "anthropic/claude-sonnet-4-6": "llm-anthropic-sonnet",
    "anthropic/claude-opus-4-7": "llm-anthropic-opus",
    "anthropic/claude-opus-4-6": "llm-anthropic-opus",
    "anthropic/claude-haiku-4-5-20251001": "llm-anthropic-haiku",
    "anthropic/claude-haiku-4-5": "llm-anthropic-haiku",
    "claude-sonnet-4-6": "llm-anthropic-sonnet",
    "claude-opus-4-7": "llm-anthropic-opus",
    "claude-opus-4-6": "llm-anthropic-opus",
    "claude-haiku-4-5-20251001": "llm-anthropic-haiku",
    "claude-haiku-4-5": "llm-anthropic-haiku",
    # OpenAI
    "openai/gpt-5.4": "llm-openai-gpt5",
    "gpt-5.4": "llm-openai-gpt5",
    "openai/o3": "llm-openai-o3",
    "o3": "llm-openai-o3",
    # NVIDIA NIM / build API
    "nvidia/meta/llama-3.1-8b-instruct": "llm-nvidia-llama31-8b",
    "meta/llama-3.1-8b-instruct": "llm-nvidia-llama31-8b",
    "nvidia/mistralai/mistral-medium-3.5-128b": "llm-nvidia-mistral-medium-35-128b",
    "mistralai/mistral-medium-3.5-128b": "llm-nvidia-mistral-medium-35-128b",
    "nvidia/qwen/qwen3-coder-480b-a35b-instruct": "llm-nvidia-qwen3-coder-480b",
    "qwen/qwen3-coder-480b-a35b-instruct": "llm-nvidia-qwen3-coder-480b",
    "nvidia/mistralai/devstral-2-123b-instruct-2512": "llm-nvidia-devstral-2-123b",
    "mistralai/devstral-2-123b-instruct-2512": "llm-nvidia-devstral-2-123b",
    "nvidia/moonshotai/kimi-k2-thinking": "llm-nvidia-kimi-k2-thinking",
    "moonshotai/kimi-k2-thinking": "llm-nvidia-kimi-k2-thinking",
    "nvidia/moonshotai/kimi-k2-instruct-0905": "llm-nvidia-kimi-k2-0905",
    "moonshotai/kimi-k2-instruct-0905": "llm-nvidia-kimi-k2-0905",
    "nvidia/z-ai/glm4.7": "llm-nvidia-glm47",
    "z-ai/glm4.7": "llm-nvidia-glm47",
    # Azure AI Foundry direct models
    "foundry/DeepSeek-V4-Flash": "llm-foundry-deepseek-v4-flash",
    "DeepSeek-V4-Flash": "llm-foundry-deepseek-v4-flash",
    "foundry/Kimi-K2.6": "llm-foundry-kimi-k26",
    "Kimi-K2.6": "llm-foundry-kimi-k26",
    # Together AI OpenAI-compatible serverless models
    "together/zai-org/GLM-5.1": "llm-together-glm-51",
    "zai-org/GLM-5.1": "llm-together-glm-51",
    "GLM-5.1": "llm-together-glm-51",
    "glm-5.1": "llm-together-glm-51",
    "together/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8": "llm-together-qwen3-coder-480b",
    "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8": "llm-together-qwen3-coder-480b",
    "qwen3-coder-480b-a35b-instruct-fp8": "llm-together-qwen3-coder-480b",
    "together/deepseek-ai/DeepSeek-V4-Pro": "llm-together-deepseek-v4-pro",
    "deepseek-ai/DeepSeek-V4-Pro": "llm-together-deepseek-v4-pro",
    "DeepSeek-V4-Pro": "llm-together-deepseek-v4-pro",
    # GoogleAI
    "googleai/gemini-3.1-pro-preview": "llm-google-gemini",
    "google/gemini-3.1-pro-preview": "llm-google-gemini",
    "gemini-3.1-pro-preview": "llm-google-gemini",
    # DeepSeek
    "deepseek/deepseek-v4-pro": "llm-deepseek-v4-pro",
    "deepseek-v4-pro": "llm-deepseek-v4-pro",
    "deepseek/deepseek-v4-flash": "llm-deepseek-v4-flash",
    "deepseek-v4-flash": "llm-deepseek-v4-flash",
    "deepseek/default": "llm-deepseek",
    # Alibaba Cloud Model Studio international endpoint
    "alibaba/qwen3-coder-plus": "llm-alibaba-qwen3-coder-plus",
    "qwen3-coder-plus": "llm-alibaba-qwen3-coder-plus",
    "qwen/qwen3-coder-plus": "llm-alibaba-qwen3-coder-plus",
    "dashscope/qwen3-coder-plus": "llm-alibaba-qwen3-coder-plus",
    # Kimi direct API
    "kimi/kimi-k2.6": "llm-kimi-k26",
    "kimi-k2.6": "llm-kimi-k26",
    "moonshot/kimi-k2.6": "llm-kimi-k26",
    "kimi/kimi-k2.5": "llm-kimi-k25",
    "kimi-k2.5": "llm-kimi-k25",
    "moonshot/kimi-k2.5": "llm-kimi-k25",
    # Hugging Face
    "huggingface/meta-llama/Meta-Llama-3-8B": "llm-huggingface-llama3",
    "meta-llama/Meta-Llama-3-8B": "llm-huggingface-llama3",
    # Mistral
    "mistral/open-mistral-7b": "llm-mistral-open",
    "open-mistral-7b": "llm-mistral-open",
    # Local echo
    "echo/local": "llm-echo",
}


DEFAULT_LLM_COMPONENT = os.environ.get(
    "DAPR_LLM_COMPONENT_DEFAULT", "llm-anthropic-opus"
)


_COMPONENT_PROVIDER_MODELS: dict[str, tuple[str, str]] = {
    "llm-anthropic-sonnet": ("anthropic", "claude-sonnet-4-6"),
    "llm-anthropic-opus": ("anthropic", "claude-opus-4-7"),
    "llm-anthropic-haiku": ("anthropic", "claude-haiku-4-5-20251001"),
    "llm-openai-gpt5": ("openai", "gpt-5.4"),
    "llm-openai-o3": ("openai", "o3"),
    "llm-nvidia-llama31-8b": ("nvidia", "meta/llama-3.1-8b-instruct"),
    "llm-nvidia-mistral-medium-35-128b": (
        "nvidia",
        "mistralai/mistral-medium-3.5-128b",
    ),
    "llm-nvidia-qwen3-coder-480b": (
        "nvidia",
        "qwen/qwen3-coder-480b-a35b-instruct",
    ),
    "llm-nvidia-devstral-2-123b": (
        "nvidia",
        "mistralai/devstral-2-123b-instruct-2512",
    ),
    "llm-nvidia-kimi-k2-thinking": ("nvidia", "moonshotai/kimi-k2-thinking"),
    "llm-nvidia-kimi-k2-0905": ("nvidia", "moonshotai/kimi-k2-instruct-0905"),
    "llm-nvidia-glm47": ("nvidia", "z-ai/glm4.7"),
    "llm-foundry-deepseek-v4-flash": ("foundry", "DeepSeek-V4-Flash"),
    "llm-foundry-kimi-k26": ("foundry", "Kimi-K2.6"),
    "llm-together-glm-51": ("together", "zai-org/GLM-5.1"),
    "llm-together-qwen3-coder-480b": (
        "together",
        "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
    ),
    "llm-together-deepseek-v4-pro": ("together", "deepseek-ai/DeepSeek-V4-Pro"),
    "llm-google-gemini": ("googleai", "gemini-3.1-pro-preview"),
    "llm-deepseek-v4-pro": ("deepseek", "deepseek-v4-pro"),
    "llm-deepseek-v4-flash": ("deepseek", "deepseek-v4-flash"),
    "llm-deepseek": ("deepseek", "default"),
    "llm-alibaba-qwen3-coder-plus": ("alibaba", "qwen3-coder-plus"),
    "llm-kimi-k26": ("kimi", "kimi-k2.6"),
    "llm-kimi-k25": ("kimi", "kimi-k2.5"),
    "llm-huggingface-llama3": ("huggingface", "meta-llama/Meta-Llama-3-8B"),
    "llm-mistral-open": ("mistral", "open-mistral-7b"),
    "llm-echo": ("echo", "local"),
}


def _record(value: Any) -> dict[str, Any] | None:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return dict(parsed) if isinstance(parsed, Mapping) else None
    return None


def _string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _number(value: Any) -> int | float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = float(value)
        except ValueError:
            return None
        return int(parsed) if parsed.is_integer() else parsed
    return None


def _int(value: Any) -> int | None:
    parsed = _number(value)
    return int(parsed) if isinstance(parsed, (int, float)) else None


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted({str(item).strip() for item in value if str(item).strip()})


def _canonicalize(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, list):
        return [_canonicalize(item) for item in value]
    if isinstance(value, Mapping):
        return {
            key: _canonicalize(inner)
            for key, inner in sorted(value.items(), key=lambda item: item[0])
            if inner is not None
        }
    return value


def canonical_json(value: Any) -> str:
    return json.dumps(
        _canonicalize(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def stable_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def resolve_llm_component(model_spec: str | None) -> str:
    """Map an optional workflow-builder modelSpec to a Dapr LLM component."""
    if not model_spec or not model_spec.strip():
        return DEFAULT_LLM_COMPONENT
    normalized = model_spec.strip()
    component = MODEL_COMPONENT_MAP.get(normalized)
    if component is None:
        raise ValueError(
            f"Unknown modelSpec {normalized!r}. "
            f"Available models: {', '.join(sorted(MODEL_COMPONENT_MAP.keys()))}"
        )
    return component


def provider_metadata_for_component(
    llm_component: str,
    model_spec: str | None = None,
) -> dict[str, str]:
    """Return provider/providerModel metadata for a resolved Dapr component."""
    component = str(llm_component or "").strip()
    mapped = _COMPONENT_PROVIDER_MODELS.get(component)
    if mapped:
        return {"provider": mapped[0], "providerModel": mapped[1]}
    lowered = component.lower()
    if "anthropic" in lowered:
        provider = "anthropic"
    elif "openai" in lowered:
        provider = "openai"
    elif "nvidia" in lowered:
        provider = "nvidia"
    elif "foundry" in lowered:
        provider = "foundry"
    elif "together" in lowered:
        provider = "together"
    elif "google" in lowered:
        provider = "googleai"
    elif "deepseek" in lowered:
        provider = "deepseek"
    elif "alibaba" in lowered or "dashscope" in lowered:
        provider = "alibaba"
    elif "kimi" in lowered:
        provider = "kimi"
    elif "huggingface" in lowered:
        provider = "huggingface"
    elif "mistral" in lowered:
        provider = "mistral"
    elif "echo" in lowered:
        provider = "echo"
    else:
        provider = "unknown"
    out = {"provider": provider}
    text = _string(model_spec)
    if text:
        out["providerModel"] = text.split("/", 1)[1] if "/" in text else text
    return out


def resolve_llm_metadata(
    message: Mapping[str, Any] | None = None,
    metadata: Mapping[str, Any] | None = None,
    agent_config: Mapping[str, Any] | None = None,
) -> dict[str, str]:
    """Resolve modelSpec, Dapr component, provider, and provider model.

    Priority matches the runtime path:
    agentConfig.modelSpec -> metadata.model -> top-level message.model -> default.
    """
    message_record = dict(message or {})
    metadata_record = dict(metadata or {})
    config = dict(agent_config or _record(message_record.get("agentConfig")) or {})

    model_spec = (
        _string(config.get("modelSpec"))
        or _string(metadata_record.get("model"))
        or _string(message_record.get("model"))
    )
    component = resolve_llm_component(model_spec)
    provider = provider_metadata_for_component(component, model_spec)
    out = {
        "llmComponent": component,
        "provider": provider.get("provider", "unknown"),
    }
    if model_spec:
        out["modelSpec"] = model_spec
    if provider.get("providerModel"):
        out["providerModel"] = provider["providerModel"]
    return out


def _normalize_transport(value: Any) -> str | None:
    raw = str(value or "").strip().lower()
    if not raw:
        return None
    text = raw.replace("-", "_")
    if text in {"http", "streamablehttp"}:
        return "streamable_http"
    if text in {"ws", "web_socket"}:
        return "websocket"
    return text


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


def _mcp_server_name(item: Mapping[str, Any]) -> str:
    for key in (
        "server_name",
        "serverName",
        "name",
        "displayName",
        "pieceName",
        "serverKey",
        "registryRef",
        "url",
        "serverUrl",
        "command",
    ):
        value = _string(item.get(key))
        if value:
            return _normalize_mcp_server_name(value)
    return "mcp_server"


def _snapshot_mcp_servers(agent_config: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw_servers = agent_config.get("mcpServers") or []
    if not isinstance(raw_servers, list):
        return []
    servers: list[dict[str, Any]] = []
    seen: dict[str, int] = {}
    for item in raw_servers:
        if not isinstance(item, Mapping):
            continue
        base_name = _mcp_server_name(item)
        seen[base_name] = seen.get(base_name, 0) + 1
        server_name = base_name if seen[base_name] == 1 else f"{base_name}_{seen[base_name]}"
        server: dict[str, Any] = {"serverName": server_name}
        transport = _normalize_transport(
            item.get("transport") or item.get("type") or "streamable_http"
        )
        if transport:
            server["transport"] = transport
        tool_names = _string_list(item.get("allowedTools") or item.get("allowed_tools"))
        if tool_names:
            server["toolNames"] = tool_names
        servers.append(server)
    return sorted(servers, key=lambda entry: canonical_json(entry))


def _agent_snapshot(raw_message: Mapping[str, Any], agent_config: Mapping[str, Any]) -> dict[str, Any]:
    agent: dict[str, Any] = {}
    for out_key, keys in {
        "id": ("agentId", "agent_id", "id"),
        "slug": ("agentSlug", "agent_slug", "slug"),
        "appid": ("agentAppId", "agent_app_id", "appId", "appid"),
        "runtime": ("runtime",),
        "registryTeam": ("registryTeam", "registry_team"),
        "registryKey": ("registryKey", "registry_key"),
    }.items():
        value = None
        for key in keys:
            value = _string(raw_message.get(key))
            if value:
                break
            value = _string(agent_config.get(key))
            if value:
                break
        if value:
            agent[out_key] = value

    version = (
        _int(raw_message.get("agentVersion"))
        or _int(raw_message.get("agent_version"))
        or _int(agent_config.get("version"))
    )
    if version is not None:
        agent["version"] = version
    return agent


def _execution_snapshot(
    raw_message: Mapping[str, Any],
    agent_config: Mapping[str, Any],
    cwd: str,
) -> dict[str, Any]:
    execution: dict[str, Any] = {"cwd": cwd}
    for key in ("maxTurns", "maxIterations", "timeoutMinutes"):
        value = _number(raw_message.get(key))
        if value is None:
            value = _number(agent_config.get(key))
        if value is not None:
            execution[key] = value
    if "maxIterations" not in execution:
        value = _number(agent_config.get("max_iterations"))
        if value is not None:
            execution["maxIterations"] = value
    for key in ("toolChoice", "permissionMode"):
        value = _string(raw_message.get(key)) or _string(agent_config.get(key))
        if value:
            execution[key] = value
    return execution


def _tools_snapshot(agent_config: Mapping[str, Any]) -> dict[str, Any]:
    mcp_servers = _snapshot_mcp_servers(agent_config)
    allowed_tools = _string_list(
        agent_config.get("tools")
        or agent_config.get("allowedTools")
        or agent_config.get("allowed_tools")
    )
    tools: dict[str, Any] = {
        "allowedTools": allowed_tools,
        "builtinTools": _string_list(agent_config.get("builtinTools")),
        "mcpServers": mcp_servers,
    }
    if mcp_servers:
        tools["mcpConfigHash"] = stable_hash(mcp_servers)
    return tools


def build_effective_agent_config(
    *,
    agent_config: Mapping[str, Any] | None,
    raw_message: Mapping[str, Any] | None,
    turn: int,
    config_revision: int,
    cwd: str,
    instruction_bundle: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a compact per-turn effectiveAgentConfig snapshot."""
    config = dict(agent_config or {})
    message = dict(raw_message or {})
    llm = resolve_llm_metadata(message=message, agent_config=config)
    body = {
        "schemaVersion": EFFECTIVE_AGENT_CONFIG_SCHEMA_VERSION,
        "agent": _agent_snapshot(message, config),
        "llm": llm,
        "execution": _execution_snapshot(message, config, cwd),
        "tools": _tools_snapshot(config),
    }
    snapshot = {
        **body,
        "turn": int(turn),
        "configRevision": int(config_revision),
    }
    snapshot["configHash"] = stable_hash(body)
    bundle = dict(instruction_bundle or {})
    instruction_hash = _string(bundle.get("instructionHash"))
    if instruction_hash:
        snapshot["instructionHash"] = instruction_hash
    template_name = _string(bundle.get("templateName"))
    if template_name:
        snapshot["templateName"] = template_name
    template_hash = _string(bundle.get("templateHash"))
    if template_hash:
        snapshot["templateHash"] = template_hash
    schema_version = _string(bundle.get("schemaVersion"))
    if schema_version:
        snapshot["instructionBundleSchemaVersion"] = schema_version
    sources = bundle.get("sources")
    if isinstance(sources, list):
        snapshot["instructionSources"] = [
            dict(item) for item in sources if isinstance(item, Mapping)
        ]
    if bundle:
        snapshot["instructionTextStored"] = True
    return snapshot


def effective_audit_fields(snapshot: Mapping[str, Any] | None) -> dict[str, Any]:
    """Return the small audit field set stamped onto events and spans."""
    if not isinstance(snapshot, Mapping):
        return {}
    llm = snapshot.get("llm") if isinstance(snapshot.get("llm"), Mapping) else {}
    out: dict[str, Any] = {}
    for key in (
        "turn",
        "configRevision",
        "configHash",
        "instructionHash",
        "templateName",
        "templateHash",
    ):
        if snapshot.get(key) is not None:
            out[key] = snapshot.get(key)
    for key in ("modelSpec", "llmComponent", "provider", "providerModel"):
        if llm.get(key) is not None:
            out[key] = llm.get(key)
    return out


def runtime_context_audit_cache_fields(context: Mapping[str, Any] | None) -> dict[str, Any]:
    """Return audit fields that must survive the in-memory runtime cache.

    The durable state copy stores the full effectiveAgentConfig snapshot, but
    the hot path reads from an in-memory per-instance cache first. Keep this
    compact set in memory so provider usage events and spans do not lose
    revision/model provenance after the context is first remembered.
    """
    if not isinstance(context, Mapping):
        return {}

    out: dict[str, Any] = {}
    snapshot = context.get("effectiveAgentConfig")
    if isinstance(snapshot, Mapping):
        out.update(effective_audit_fields(snapshot))

    for key in (
        "turn",
        "configRevision",
        "configHash",
        "instructionHash",
        "templateName",
        "templateHash",
        "modelSpec",
        "llmComponent",
        "provider",
        "providerModel",
    ):
        if context.get(key) is not None:
            out[key] = context.get(key)
    if isinstance(snapshot, Mapping):
        out["effectiveAgentConfig"] = snapshot
    return out
