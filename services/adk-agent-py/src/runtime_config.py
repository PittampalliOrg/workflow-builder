"""CloudEvents runtime configuration inspection for adk-agent-py."""

from __future__ import annotations

import hashlib
import json
import os
import urllib.parse
import urllib.request
from typing import Any, Mapping, Sequence

from src.event_publisher import publish_session_event


SESSION_RUNTIME_CONFIG_EVENT_TYPE = "session.runtime_config"
CLOUDEVENT_TYPE = "io.workflow-builder.session.runtime_config.v1"
CLOUDEVENT_DATASCHEMA = "urn:workflow-builder:schema:agent-runtime-config:v1"
DOMAIN_SCHEMA_VERSION = "workflow-builder.agent_runtime_config.v1"
RUNTIME_CONFIG_ACTIVITY_NAME = "record_runtime_config_inspection"

_RUNTIME_CONFIG_BY_INSTANCE: dict[str, dict[str, Any]] = {}
_RUNTIME_CONFIG_BY_SESSION: dict[str, dict[str, Any]] = {}


def runtime_config_state_key(instance_id: str) -> str:
    return f"runtime-config:{instance_id}"


def _canonical(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, list):
        return [_canonical(item) for item in value]
    if isinstance(value, Mapping):
        return {
            key: _canonical(inner)
            for key, inner in sorted(value.items(), key=lambda item: str(item[0]))
            if inner is not None
        }
    return value


def _stable_hash(value: Any) -> str:
    encoded = json.dumps(
        _canonical(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


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


def _tool_summary(tool: Any) -> dict[str, Any]:
    if isinstance(tool, Mapping):
        name = _string(tool.get("name"))
        description = _string(tool.get("description"))
        parameters = tool.get("parameters")
        class_name = _string(tool.get("className") or tool.get("type"))
    else:
        name = _string(getattr(tool, "name", None))
        description = _string(getattr(tool, "description", None))
        class_name = type(tool).__name__
        parameters = None
        get_decl = getattr(tool, "_get_declaration", None)
        if callable(get_decl):
            try:
                decl = get_decl()
                params = getattr(decl, "parameters", None) if decl else None
                if params is not None:
                    if hasattr(params, "model_dump"):
                        parameters = params.model_dump(exclude_none=True)
                    elif hasattr(params, "to_dict"):
                        parameters = params.to_dict()
            except Exception:
                parameters = None
    entry: dict[str, Any] = {"name": name, "className": class_name}
    if description:
        entry["descriptionHash"] = _stable_hash(description)
    if parameters is not None:
        entry["schemaHash"] = _stable_hash(parameters)
    return {key: value for key, value in entry.items() if value not in (None, "")}


def summarize_declared_tools(declared_tools: Sequence[Any]) -> list[dict[str, Any]]:
    return [_tool_summary(tool) for tool in declared_tools]


def _instruction_hash(input_data: Mapping[str, Any]) -> str | None:
    bundle = _mapping(input_data.get("instructionBundle"))
    for key in ("instructionHash", "templateHash"):
        value = _string(bundle.get(key))
        if value:
            return value
    rendered = _mapping(bundle.get("rendered"))
    system = _string(rendered.get("system"))
    return _stable_hash(system) if system else None


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


def _state_sidecar_url() -> str:
    endpoint = os.environ.get("DAPR_HTTP_ENDPOINT", "").strip()
    if endpoint:
        return endpoint.rstrip("/")
    return (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )


def _state_store_name() -> str:
    return (
        os.environ.get("AGENT_STATE_STORE")
        or os.environ.get("DAPR_AGENT_STATESTORE")
        or "dapr-agent-py-statestore"
    )


def _dapr_api_token_headers() -> dict[str, str]:
    token = str(os.environ.get("DAPR_API_TOKEN") or "").strip()
    return {"dapr-api-token": token} if token else {}


def _save_state(key: str, value: Mapping[str, Any]) -> None:
    encoded_key = urllib.parse.quote(key, safe="")
    payload = json.dumps(
        [{"key": key, "value": value, "metadata": {"partitionKey": encoded_key}}],
        default=str,
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{_state_sidecar_url()}/v1.0/state/{urllib.parse.quote(_state_store_name(), safe='')}",
        data=payload,
        headers={"Content-Type": "application/json", **_dapr_api_token_headers()},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=5)


def _read_state(key: str) -> Any:
    encoded_key = urllib.parse.quote(key, safe="")
    req = urllib.request.Request(
        (
            f"{_state_sidecar_url()}/v1.0/state/"
            f"{urllib.parse.quote(_state_store_name(), safe='')}/{encoded_key}"
            f"?metadata.partitionKey={encoded_key}"
        ),
        headers=_dapr_api_token_headers(),
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=2) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except Exception:
        return None
    try:
        parsed: Any = json.loads(raw)
        while isinstance(parsed, str):
            parsed = json.loads(parsed)
        return parsed
    except Exception:
        return raw


def build_adk_runtime_config_event(
    *,
    input_data: Mapping[str, Any],
    per_turn_config: Mapping[str, Any],
    telemetry_context: Mapping[str, Any],
    declared_tools: Sequence[Any],
    child_instance_id: str,
    turn: int,
    source: str = "memory",
) -> dict[str, Any]:
    agent_config = _mapping(input_data.get("agentConfig"))
    mlflow_context = _mapping(input_data.get("mlflowContext"))
    session_id = _string(input_data.get("sessionId")) or _string(
        telemetry_context.get("agent.session.id")
    )
    if not session_id:
        raise ValueError("runtime config inspection requires sessionId")
    agent = {
        "id": telemetry_context.get("agent.id") or input_data.get("agentId"),
        "version": telemetry_context.get("agent.version")
        or input_data.get("agentVersion"),
        "slug": telemetry_context.get("agent.slug") or input_data.get("agentSlug"),
        "appid": telemetry_context.get("agent.app_id") or input_data.get("agentAppId"),
        "runtime": agent_config.get("runtime") or "adk-agent-py",
    }
    agent = {key: value for key, value in agent.items() if value not in (None, "")}
    llm = {
        "provider": per_turn_config.get("provider") or "gemini",
        "modelSpec": agent_config.get("modelSpec"),
        "providerModel": per_turn_config.get("model"),
        "llmComponent": per_turn_config.get("component_name")
        or telemetry_context.get("dapr.component"),
    }
    llm = {key: value for key, value in llm.items() if value not in (None, "")}
    tool_summaries = summarize_declared_tools(declared_tools)
    mcp_tools = [
        tool for tool in tool_summaries if "mcp" in str(tool.get("className", "")).lower()
    ]
    tools = {
        "declaredTools": tool_summaries,
        "toolCount": len(tool_summaries),
        "toolSchemaHash": _stable_hash(tool_summaries),
    }
    raw_mcp_servers = agent_config.get("mcpServers")
    mcp_server_count = len(raw_mcp_servers) if isinstance(raw_mcp_servers, list) else 0
    mcp = {
        "scope": "pod_bootstrap",
        "serverCount": mcp_server_count,
        "toolCount": len(mcp_tools),
        "configHash": _stable_hash(raw_mcp_servers or []),
    }
    instruction_hash = _instruction_hash(input_data)
    config_hash = _stable_hash(
        {
            "agent": agent,
            "llm": llm,
            "tools": tools,
            "mcp": mcp,
            "instructionHash": instruction_hash,
        }
    )
    data = {
        "schemaVersion": DOMAIN_SCHEMA_VERSION,
        "source": source,
        "sessionId": session_id,
        "instanceId": child_instance_id,
        "turn": int(turn),
        "configRevision": _int(input_data.get("configRevision")) or 0,
        "configHash": config_hash,
        "agent": agent,
        "llm": llm,
        "execution": {
            "cwd": telemetry_context.get("sandbox.cwd"),
            "sandboxName": telemetry_context.get("sandbox.name"),
            "workspaceRef": telemetry_context.get("sandbox.workspace_ref"),
            "maxIterations": input_data.get("maxIterations")
            or agent_config.get("maxTurns"),
        },
        "tools": tools,
        "mcp": mcp,
        "skills": [
            {"name": name}
            for name in _list_strings(agent_config.get("skills"))
        ],
        "instructions": {
            key: value
            for key, value in {
                "instructionHash": instruction_hash,
                "systemInstructionHash": per_turn_config.get("systemInstructionHash")
                or (
                    _stable_hash(per_turn_config.get("system_instruction"))
                    if per_turn_config.get("system_instruction")
                    else None
                ),
            }.items()
            if value
        },
        "mlflow": {
            "experimentId": mlflow_context.get("experimentId"),
            "traceExperimentId": mlflow_context.get("traceExperimentId"),
            "runId": mlflow_context.get("runId"),
            "parentRunId": mlflow_context.get("parentRunId"),
            "mlflowSessionId": mlflow_context.get("mlflowSessionId") or session_id,
            "activeModelId": mlflow_context.get("activeModelId"),
            "activeModelName": mlflow_context.get("activeModelName"),
            "activeModelUri": mlflow_context.get("activeModelUri"),
        },
        "dapr": {
            "appId": telemetry_context.get("agent.app_id")
            or input_data.get("agentAppId")
            or os.environ.get("APP_ID")
            or os.environ.get("DAPR_APP_ID")
            or "adk-agent-py",
            "workflowInstanceId": child_instance_id,
        },
    }
    data["execution"] = {
        key: value for key, value in data["execution"].items() if value not in (None, "")
    }
    data["mlflow"] = {
        key: value for key, value in data["mlflow"].items() if value not in (None, "")
    }
    data["attributes"] = {
        key: value
        for key, value in {
            "gen_ai.provider.name": llm.get("provider"),
            "gen_ai.request.model": llm.get("providerModel") or llm.get("modelSpec"),
            "gen_ai.operation.name": "chat",
            "openinference.span.kind": "LLM",
            "agent.id": agent.get("id"),
            "agent.version": agent.get("version"),
            "dapr.app_id": data["dapr"]["appId"],
            "dapr.workflow.instance_id": child_instance_id,
            "workflow.execution.id": telemetry_context.get("workflow.execution.id"),
            "session.id": session_id,
            "agent.session.id": session_id,
            "mlflow.run_id": data["mlflow"].get("runId"),
        }.items()
        if value not in (None, "")
    }

    event_id = (
        f"session:{session_id}:{child_instance_id}:turn:{int(turn)}:"
        f"runtime_config:{config_hash}"
    )
    envelope = {
        "specversion": "1.0",
        "id": event_id,
        "source": f"urn:workflow-builder:agent-runtime:{data['dapr']['appId']}",
        "type": CLOUDEVENT_TYPE,
        "subject": f"sessions/{session_id}/turns/{int(turn)}",
        "datacontenttype": "application/json",
        "dataschema": CLOUDEVENT_DATASCHEMA,
        "data": data,
    }
    traceparent = _current_traceparent()
    if traceparent:
        envelope["traceparent"] = traceparent
    return envelope


def record_runtime_config_activity(_ctx: Any, payload: dict[str, Any]) -> dict[str, Any]:
    event = build_adk_runtime_config_event(
        input_data=_mapping(payload.get("inputData")),
        per_turn_config=_mapping(payload.get("perTurnConfig")),
        telemetry_context=_mapping(payload.get("telemetryContext")),
        declared_tools=list(payload.get("declaredTools") or []),
        child_instance_id=str(payload.get("childInstanceId") or ""),
        turn=_int(payload.get("turn")) or 0,
        source="memory",
    )
    session_id = event["data"]["sessionId"]
    instance_id = event["data"]["instanceId"]
    _RUNTIME_CONFIG_BY_INSTANCE[instance_id] = event
    _RUNTIME_CONFIG_BY_SESSION[session_id] = event
    try:
        _save_state(runtime_config_state_key(instance_id), event)
        if session_id != instance_id:
            _save_state(runtime_config_state_key(session_id), event)
    except Exception:
        pass
    publish_session_event(
        session_id,
        SESSION_RUNTIME_CONFIG_EVENT_TYPE,
        event,
        source_event_id=event["id"],
        instance_id=instance_id,
    )
    return {"ok": True, "sourceEventId": event["id"], "configHash": event["data"]["configHash"]}


def get_runtime_config_snapshot(instance_id: str) -> dict[str, Any] | None:
    text = str(instance_id or "").strip()
    if not text:
        return None
    event = _RUNTIME_CONFIG_BY_INSTANCE.get(text) or _RUNTIME_CONFIG_BY_SESSION.get(text)
    if event:
        return event
    state_value = _read_state(runtime_config_state_key(text))
    return state_value if isinstance(state_value, dict) else None
