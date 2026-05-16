from __future__ import annotations

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import runtime_config  # noqa: E402
from src.runtime_config import (  # noqa: E402
    CLOUDEVENT_TYPE,
    SESSION_RUNTIME_CONFIG_EVENT_TYPE,
    build_adk_runtime_config_event,
    record_runtime_config_activity,
)


def test_adk_runtime_config_event_is_cloudevents_shaped_and_redacted() -> None:
    event = _event()
    encoded = json.dumps(event, sort_keys=True)

    assert event["specversion"] == "1.0"
    assert event["type"] == CLOUDEVENT_TYPE
    assert event["subject"] == "sessions/session-1/turns/1"
    assert event["data"]["mcp"]["scope"] == "pod_bootstrap"
    assert event["data"]["mcp"]["serverCount"] == 1
    assert event["data"]["mcp"]["servers"][0]["auth"] == "external_reference"
    assert event["data"]["tools"]["toolCount"] == 1
    assert event["data"]["instructions"]["systemInstructionHash"] == "system-hash"
    assert "hidden system prompt" not in encoded
    assert "Bearer secret" not in encoded
    assert "properties" not in encoded
    assert "system_instruction" not in encoded
    assert "tool_definitions" not in encoded


def test_adk_mcp_config_hash_ignores_secret_values() -> None:
    first_payload = _activity_payload()
    second_payload = _activity_payload()
    first_payload["inputData"]["agentConfig"]["mcpServers"][0]["headers"] = {
        "Authorization": "Bearer secret-one"
    }
    second_payload["inputData"]["agentConfig"]["mcpServers"][0]["headers"] = {
        "Authorization": "Bearer secret-two"
    }

    first = build_adk_runtime_config_event(
        input_data=first_payload["inputData"],
        per_turn_config=first_payload["perTurnConfig"],
        telemetry_context=first_payload["telemetryContext"],
        declared_tools=first_payload["declaredTools"],
        child_instance_id="child-1",
        turn=1,
    )
    second = build_adk_runtime_config_event(
        input_data=second_payload["inputData"],
        per_turn_config=second_payload["perTurnConfig"],
        telemetry_context=second_payload["telemetryContext"],
        declared_tools=second_payload["declaredTools"],
        child_instance_id="child-1",
        turn=1,
    )

    assert first["data"]["mcp"]["configHash"] == second["data"]["mcp"]["configHash"]
    assert (
        first["data"]["mcp"]["servers"][0]["configHash"]
        == second["data"]["mcp"]["servers"][0]["configHash"]
    )
    assert "secret-one" not in json.dumps(first, sort_keys=True)
    assert "secret-two" not in json.dumps(second, sort_keys=True)


def test_adk_runtime_config_attributes_are_searchable() -> None:
    attrs = _event()["data"]["attributes"]

    assert attrs["gen_ai.provider.name"] == "gemini"
    assert attrs["gen_ai.request.model"] == "gemini-2.5-flash"
    assert attrs["gen_ai.operation.name"] == "chat"
    assert attrs["openinference.span.kind"] == "LLM"
    assert attrs["agent.id"] == "agent-1"
    assert attrs["agent.version"] == 3
    assert attrs["dapr.app_id"] == "agent-runtime-adk-agent"
    assert attrs["dapr.workflow.instance_id"] == "child-1"
    assert attrs["workflow.execution.id"] == "workflow-exec-1"
    assert attrs["session.id"] == "session-1"


def test_record_runtime_config_activity_is_idempotent_by_source_event_id(monkeypatch):
    saved: list[tuple[str, dict]] = []
    published: list[tuple[tuple, dict]] = []

    monkeypatch.setattr(
        runtime_config,
        "_save_state",
        lambda key, value: saved.append((key, value)),
    )
    monkeypatch.setattr(
        runtime_config,
        "publish_session_event",
        lambda *args, **kwargs: published.append((args, kwargs)),
    )

    first = record_runtime_config_activity(None, _activity_payload())
    second = record_runtime_config_activity(None, _activity_payload())

    assert first["sourceEventId"] == second["sourceEventId"]
    assert len(saved) == 4
    assert [entry[0][1] for entry in published] == [
        SESSION_RUNTIME_CONFIG_EVENT_TYPE,
        SESSION_RUNTIME_CONFIG_EVENT_TYPE,
    ]
    assert published[0][1]["source_event_id"] == first["sourceEventId"]
    assert published[1][1]["source_event_id"] == first["sourceEventId"]


def _event() -> dict:
    return build_adk_runtime_config_event(
        input_data=_activity_payload()["inputData"],
        per_turn_config=_activity_payload()["perTurnConfig"],
        telemetry_context=_activity_payload()["telemetryContext"],
        declared_tools=_activity_payload()["declaredTools"],
        child_instance_id="child-1",
        turn=1,
    )


def _activity_payload() -> dict:
    return {
        "inputData": {
            "sessionId": "session-1",
            "agentId": "agent-1",
            "agentVersion": 3,
            "agentSlug": "adk-agent",
            "agentAppId": "agent-runtime-adk-agent",
            "agentConfig": {
                "runtime": "adk-agent-py",
                "modelSpec": "googleai/gemini-2.5-flash",
                "mcpServers": [
                    {
                        "serverName": "private",
                        "headers": {"Authorization": "Bearer secret"},
                    }
                ],
            },
            "instructionBundle": {
                "instructionHash": "instruction-hash",
            },
            "mlflowContext": {"runId": "run-1"},
        },
        "perTurnConfig": {
            "provider": "gemini",
            "model": "gemini-2.5-flash",
            "component_name": "llm-gemini",
            "systemInstructionHash": "system-hash",
        },
        "telemetryContext": {
            "agent.session.id": "session-1",
            "agent.id": "agent-1",
            "agent.version": 3,
            "agent.slug": "adk-agent",
            "agent.app_id": "agent-runtime-adk-agent",
            "workflow.execution.id": "workflow-exec-1",
            "dapr.component": "llm-gemini",
        },
        "declaredTools": [
            {
                "name": "Search",
                "className": "FunctionTool",
                "description": "hidden system prompt",
                "parameters": {"properties": {"query": {"type": "string"}}},
            }
        ],
        "childInstanceId": "child-1",
        "turn": 1,
    }
