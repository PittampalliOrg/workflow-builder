from __future__ import annotations

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.runtime_config import (  # noqa: E402
    CLOUDEVENT_TYPE,
    SESSION_RUNTIME_CONFIG_EVENT_TYPE,
    assert_no_sensitive_runtime_config_fields,
    build_runtime_config_event,
    runtime_config_state_key,
)


def test_runtime_config_event_is_cloudevents_shaped_and_stable() -> None:
    event = _event()
    again = _event()

    assert event["specversion"] == "1.0"
    assert event["type"] == CLOUDEVENT_TYPE
    assert event["datacontenttype"] == "application/json"
    assert event["dataschema"] == "urn:workflow-builder:schema:agent-runtime-config:v1"
    assert event["id"] == again["id"]
    assert event["id"].startswith(
        "session:session-1:child-1:turn:1:runtime_config:"
    )
    assert event["subject"] == "sessions/session-1/turns/1"
    assert runtime_config_state_key("child-1") == "runtime-config:child-1"
    assert SESSION_RUNTIME_CONFIG_EVENT_TYPE == "session.runtime_config"


def test_runtime_config_redacts_prompts_mcp_auth_env_and_schemas() -> None:
    event = _event()
    encoded = json.dumps(event, sort_keys=True)

    assert_no_sensitive_runtime_config_fields(event)
    assert "hidden system prompt" not in encoded
    assert "Bearer secret" not in encoded
    assert "vault-token" not in encoded
    assert "properties" not in encoded
    assert "systemPrompt" not in encoded
    assert "headers" not in encoded
    assert event["data"]["mcp"]["servers"] == [
        {
            "serverName": "github",
            "transport": "stdio",
            "connected": True,
            "configHash": event["data"]["mcp"]["servers"][0]["configHash"],
            "toolNames": ["get_issue"],
            "auth": "external_reference",
        }
    ]


def test_runtime_config_attributes_map_otel_and_openinference_keys() -> None:
    attrs = _event()["data"]["attributes"]

    assert attrs["gen_ai.provider.name"] == "openai"
    assert attrs["gen_ai.request.model"] == "openai/o3"
    assert attrs["gen_ai.operation.name"] == "chat"
    assert attrs["openinference.span.kind"] == "LLM"
    assert attrs["agent.id"] == "agent-1"
    assert attrs["agent.version"] == 7
    assert attrs["dapr.app_id"] == "agent-runtime-coding-agent"
    assert attrs["dapr.workflow.instance_id"] == "child-1"
    assert attrs["workflow.execution.id"] == "workflow-exec-1"
    assert attrs["session.id"] == "session-1"


def _event() -> dict:
    return build_runtime_config_event(
        session_id="session-1",
        instance_id="child-1",
        turn=1,
        config_revision=2,
        agent_config={
            "systemPrompt": "hidden system prompt",
            "mcpServers": [
                {
                    "serverName": "github",
                    "headers": {"Authorization": "Bearer secret"},
                    "env": {"TOKEN": "vault-token"},
                    "toolSchemas": {"get_issue": {"properties": {"q": {"type": "string"}}}},
                }
            ],
        },
        context={
            "sessionId": "session-1",
            "agentId": "agent-1",
            "agentVersion": 7,
            "agentSlug": "coding-agent",
            "agentAppId": "agent-runtime-coding-agent",
            "workflowExecutionId": "workflow-exec-1",
            "workflowId": "workflow-1",
            "nodeId": "node-1",
            "modelSpec": "openai/o3",
            "providerModel": "o3",
        },
        effective_config={
            "agent": {"id": "agent-1", "version": 7, "slug": "coding-agent"},
            "llm": {
                "provider": "openai",
                "modelSpec": "openai/o3",
                "providerModel": "o3",
            },
            "execution": {"cwd": "/workspace"},
            "tools": {"allowedTools": ["read_file"]},
        },
        instruction_bundle={"instructionHash": "instruction-hash"},
        mcp_configs={
            "github": {
                "transport": "stdio",
                "headers": {"Authorization": "Bearer secret"},
                "env": {"TOKEN": "vault-token"},
            }
        },
        mcp_allowed_tools={"github": ["get_issue"]},
        mcp_tools={"get_issue": object()},
        mcp_result={"connected": ["github"]},
        mlflow_context={"runId": "run-1"},
        dapr_app_id="agent-runtime-coding-agent",
    )
