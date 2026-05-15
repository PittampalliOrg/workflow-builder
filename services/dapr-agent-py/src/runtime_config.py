"""CloudEvents runtime configuration inspection snapshots.

The snapshot is intentionally inspection-only. It carries compact, searchable
runtime facts and hashes while omitting secrets, raw MCP transport details,
environment variables, full tool schemas, and full prompt text.
"""

from __future__ import annotations

import json
from typing import Any, Mapping, Sequence

from src.effective_agent_config import stable_hash


SESSION_RUNTIME_CONFIG_EVENT_TYPE = "session.runtime_config"
CLOUDEVENT_TYPE = "io.workflow-builder.session.runtime_config.v1"
CLOUDEVENT_DATASCHEMA = "urn:workflow-builder:schema:agent-runtime-config:v1"
DOMAIN_SCHEMA_VERSION = "workflow-builder.agent_runtime_config.v1"


def runtime_config_state_key(instance_id: str) -> str:
    return f"runtime-config:{instance_id}"


def _mapping(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _string(value: Any) -> str | None:
    if not isinstance(value, str):
        if value is None or isinstance(value, bool):
            return None
        value = str(value)
    text = value.strip()
    return text or None


def _int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _list_strings(value: Any) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return sorted({str(item).strip() for item in value if str(item).strip()})


def _hash_if_present(value: Any) -> str | None:
    if value is None:
        return None
    return stable_hash(value)


def _current_traceparent() -> str | None:
    try:
        from opentelemetry import trace

        span = trace.get_current_span()
        if span is None:
            return None
        ctx = span.get_span_context()
        if not ctx or not getattr(ctx, "is_valid", False):
            return None
        flags = int(getattr(ctx, "trace_flags", 0) or 0)
        return f"00-{ctx.trace_id:032x}-{ctx.span_id:016x}-{flags:02x}"
    except Exception:
        return None


def _redacted_mcp_servers(
    mcp_configs: Mapping[str, Any] | None,
    mcp_allowed_tools: Mapping[str, Any] | None,
    connected_names: Sequence[str] | None,
) -> list[dict[str, Any]]:
    connected = {str(name) for name in (connected_names or [])}
    servers: list[dict[str, Any]] = []
    for name, raw_cfg in sorted((mcp_configs or {}).items(), key=lambda item: item[0]):
        cfg = _mapping(raw_cfg)
        allowed = _list_strings((mcp_allowed_tools or {}).get(name))
        entry: dict[str, Any] = {
            "serverName": str(name),
            "transport": _string(cfg.get("transport")) or "streamable_http",
            "connected": str(name) in connected if connected else None,
            "configHash": stable_hash(
                {
                    "serverName": str(name),
                    "transport": _string(cfg.get("transport")) or "streamable_http",
                    "allowedTools": allowed,
                }
            ),
        }
        if allowed:
            entry["toolNames"] = allowed
        if cfg.get("headers") or cfg.get("connectionExternalId"):
            entry["auth"] = "external_reference"
        servers.append({k: v for k, v in entry.items() if v is not None})
    return servers


def _skill_summary(skill: Any) -> dict[str, Any]:
    name = _string(getattr(skill, "name", None)) or _string(
        skill.get("name") if isinstance(skill, Mapping) else None
    )
    description = _string(getattr(skill, "description", None)) or _string(
        skill.get("description") if isinstance(skill, Mapping) else None
    )
    source = _string(getattr(skill, "source", None)) or _string(
        skill.get("source") if isinstance(skill, Mapping) else None
    )
    allowed_tools = _list_strings(
        getattr(skill, "allowed_tools", None)
        if not isinstance(skill, Mapping)
        else skill.get("allowedTools") or skill.get("allowed_tools")
    )
    package_files = _list_strings(
        getattr(skill, "package_files", None)
        if not isinstance(skill, Mapping)
        else skill.get("packageFiles") or skill.get("package_files")
    )
    entry: dict[str, Any] = {
        "name": name,
        "descriptionHash": _hash_if_present(description),
        "source": source,
    }
    if allowed_tools:
        entry["allowedTools"] = allowed_tools
    if package_files:
        entry["packageFileCount"] = len(package_files)
        entry["packageFilesHash"] = stable_hash(package_files)
    return {k: v for k, v in entry.items() if v is not None}


def _instruction_summary(
    context: Mapping[str, Any],
    effective_config: Mapping[str, Any],
    instruction_bundle: Mapping[str, Any],
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in (
        "instructionHash",
        "templateName",
        "templateHash",
        "instructionBundleSchemaVersion",
    ):
        value = (
            context.get(key)
            or effective_config.get(key)
            or instruction_bundle.get(key)
        )
        if value is not None:
            out[key] = value
    sources = effective_config.get("instructionSources") or instruction_bundle.get("sources")
    if isinstance(sources, list):
        sanitized: list[dict[str, Any]] = []
        for item in sources:
            if not isinstance(item, Mapping):
                continue
            entry = {
                key: item.get(key)
                for key in (
                    "source",
                    "kind",
                    "name",
                    "templateName",
                    "templateHash",
                    "promptId",
                    "promptVersionId",
                    "version",
                    "overrideKind",
                    "hash",
                )
                if item.get(key) is not None
            }
            if entry:
                sanitized.append(entry)
        if sanitized:
            out["sources"] = sanitized
            out["sourcesHash"] = stable_hash(sanitized)
    return out


def _attributes(
    *,
    session_id: str,
    instance_id: str,
    agent: Mapping[str, Any],
    llm: Mapping[str, Any],
    context: Mapping[str, Any],
    mlflow: Mapping[str, Any],
    dapr_app_id: str | None,
) -> dict[str, Any]:
    provider = llm.get("provider") or context.get("provider")
    model = llm.get("modelSpec") or llm.get("providerModel") or context.get("modelSpec")
    attrs = {
        "gen_ai.provider.name": provider,
        "gen_ai.request.model": model,
        "gen_ai.operation.name": "chat",
        "openinference.span.kind": "LLM",
        "agent.id": agent.get("id") or context.get("agentId"),
        "agent.version": agent.get("version") or context.get("agentVersion"),
        "agent.slug": agent.get("slug") or context.get("agentSlug"),
        "dapr.app_id": dapr_app_id or agent.get("appid") or context.get("agentAppId"),
        "dapr.workflow.instance_id": instance_id,
        "workflow.execution.id": context.get("workflowExecutionId")
        or context.get("executionId"),
        "workflow.id": context.get("workflowId"),
        "workflow.node.id": context.get("nodeId"),
        "session.id": session_id,
        "agent.session.id": session_id,
        "mlflow.run_id": mlflow.get("runId"),
        "mlflow.parent_run_id": mlflow.get("parentRunId"),
        "mlflow.model_id": mlflow.get("activeModelId"),
        "mlflow.model.uri": mlflow.get("activeModelUri"),
    }
    return {key: value for key, value in attrs.items() if value not in (None, "")}


def build_runtime_config_event(
    *,
    session_id: str,
    instance_id: str,
    turn: int | None,
    config_revision: int | None,
    agent_config: Mapping[str, Any] | None = None,
    context: Mapping[str, Any] | None = None,
    effective_config: Mapping[str, Any] | None = None,
    instruction_bundle: Mapping[str, Any] | None = None,
    mcp_configs: Mapping[str, Any] | None = None,
    mcp_allowed_tools: Mapping[str, Any] | None = None,
    mcp_tools: Mapping[str, Any] | None = None,
    mcp_result: Mapping[str, Any] | None = None,
    skills: Sequence[Any] | None = None,
    mlflow_context: Mapping[str, Any] | None = None,
    dapr_app_id: str | None = None,
    source: str = "memory",
) -> dict[str, Any]:
    context = _mapping(context)
    agent_config = _mapping(agent_config)
    effective_config = _mapping(effective_config or context.get("effectiveAgentConfig"))
    instruction_bundle = _mapping(
        instruction_bundle or context.get("instructionBundle")
    )
    mlflow_context = _mapping(mlflow_context or context.get("mlflowContext"))
    mcp_result = _mapping(mcp_result)
    llm = _mapping(effective_config.get("llm"))
    agent = _mapping(effective_config.get("agent"))
    execution = _mapping(effective_config.get("execution"))
    tools = _mapping(effective_config.get("tools"))

    for out_key, context_key in (
        ("id", "agentId"),
        ("version", "agentVersion"),
        ("slug", "agentSlug"),
        ("appid", "agentAppId"),
    ):
        if agent.get(out_key) is None and context.get(context_key) is not None:
            agent[out_key] = context.get(context_key)
    if llm.get("llmComponent") is None and context.get("llmComponent"):
        llm["llmComponent"] = context.get("llmComponent")
    if llm.get("modelSpec") is None and context.get("modelSpec"):
        llm["modelSpec"] = context.get("modelSpec")
    if llm.get("providerModel") is None and context.get("providerModel"):
        llm["providerModel"] = context.get("providerModel")

    allowed_tools = _list_strings(
        context.get("allowedTools")
        or tools.get("allowedTools")
        or agent_config.get("allowedTools")
        or agent_config.get("tools")
    )
    if allowed_tools:
        tools["allowedTools"] = allowed_tools

    connected = _list_strings(mcp_result.get("connected"))
    redacted_mcp_servers = _redacted_mcp_servers(
        mcp_configs,
        mcp_allowed_tools,
        connected,
    )
    mcp = {
        "scope": "per_turn",
        "servers": redacted_mcp_servers,
        "serverCount": len(redacted_mcp_servers),
        "toolCount": len(mcp_tools or {}),
        "connected": connected,
        "error": mcp_result.get("error"),
    }
    mcp = {key: value for key, value in mcp.items() if value not in (None, [], "")}
    if redacted_mcp_servers:
        tools["mcpConfigHash"] = tools.get("mcpConfigHash") or stable_hash(
            redacted_mcp_servers
        )

    mlflow = {
        "experimentId": mlflow_context.get("experimentId"),
        "traceExperimentId": mlflow_context.get("traceExperimentId"),
        "runId": mlflow_context.get("runId"),
        "parentRunId": mlflow_context.get("parentRunId"),
        "mlflowSessionId": mlflow_context.get("mlflowSessionId") or session_id,
        "activeModelId": mlflow_context.get("activeModelId"),
        "activeModelName": mlflow_context.get("activeModelName"),
        "activeModelUri": mlflow_context.get("activeModelUri"),
    }
    mlflow = {key: value for key, value in mlflow.items() if value not in (None, "")}

    resolved_turn = _int(turn) or _int(context.get("turn")) or 0
    resolved_revision = (
        _int(config_revision) or _int(context.get("configRevision")) or 0
    )
    config_hash = (
        _string(effective_config.get("configHash"))
        or _string(context.get("configHash"))
        or stable_hash(
            {
                "agent": agent,
                "llm": llm,
                "execution": execution,
                "tools": tools,
                "mcp": mcp,
                "instructions": _instruction_summary(
                    context, effective_config, instruction_bundle
                ),
            }
        )
    )
    data = {
        "schemaVersion": DOMAIN_SCHEMA_VERSION,
        "source": source,
        "sessionId": session_id,
        "instanceId": instance_id,
        "turn": resolved_turn,
        "configRevision": resolved_revision,
        "configHash": config_hash,
        "agent": agent,
        "llm": llm,
        "execution": {
            **execution,
            "cwd": context.get("cwd") or execution.get("cwd"),
            "sandboxName": context.get("sandboxName"),
            "workspaceRef": context.get("workspaceRef"),
            "permissionMode": context.get("permissionMode")
            or execution.get("permissionMode"),
        },
        "tools": tools,
        "mcp": mcp,
        "skills": [_skill_summary(skill) for skill in (skills or [])],
        "instructions": _instruction_summary(
            context, effective_config, instruction_bundle
        ),
        "mlflow": mlflow,
        "dapr": {
            "appId": dapr_app_id or agent.get("appid") or context.get("agentAppId"),
            "workflowInstanceId": instance_id,
        },
    }
    data["execution"] = {
        key: value
        for key, value in data["execution"].items()
        if value not in (None, "")
    }
    data["attributes"] = _attributes(
        session_id=session_id,
        instance_id=instance_id,
        agent=agent,
        llm=llm,
        context=context,
        mlflow=mlflow,
        dapr_app_id=dapr_app_id,
    )

    event_id = (
        f"session:{session_id}:{instance_id}:turn:{resolved_turn}:"
        f"runtime_config:{config_hash}"
    )
    envelope = {
        "specversion": "1.0",
        "id": event_id,
        "source": f"urn:workflow-builder:agent-runtime:{data['dapr'].get('appId') or 'unknown'}",
        "type": CLOUDEVENT_TYPE,
        "subject": f"sessions/{session_id}/turns/{resolved_turn}",
        "datacontenttype": "application/json",
        "dataschema": CLOUDEVENT_DATASCHEMA,
        "data": data,
    }
    traceparent = _current_traceparent()
    if traceparent:
        envelope["traceparent"] = traceparent
    return envelope


def assert_no_sensitive_runtime_config_fields(envelope: Mapping[str, Any]) -> None:
    """Test helper: raise if known sensitive field names escaped redaction."""
    encoded = json.dumps(envelope, sort_keys=True, default=str).lower()
    for forbidden in (
        "authorization",
        "bearer ",
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
        "secret",
        "\"env\"",
        "\"headers\"",
        "\"systemprompt\"",
        "\"system_instruction\"",
    ):
        if forbidden in encoded:
            raise AssertionError(f"sensitive runtime config field leaked: {forbidden}")
