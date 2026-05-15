from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.event_publisher import _cma_shape  # noqa: E402
from src.telemetry import adk_session_events as events  # noqa: E402


def _ctx() -> dict:
    return {
        "agent.session.id": "sess-1",
        "workflow.instance_id": "child-1",
        "workflow.execution.id": "exec-1",
        "workflow.node.id": "node-1",
        "agent.iteration": 0,
        "agent.id": "agent-1",
        "agent.version": 3,
        "agent.slug": "agent-slug",
        "agent.app_id": "agent-runtime-agent-slug",
        "dapr.component": "llm-gemini",
        "gen_ai.request.model": "gemini-2.5-flash",
        "gen_ai.system": "gemini",
    }


def test_llm_complete_still_maps_to_agent_message():
    event_type, payload = _cma_shape("llm_complete", {"content": "done"})

    assert event_type == "agent.message"
    assert payload["content"] == [{"type": "text", "text": "done"}]


def test_tool_call_end_with_json_error_output_is_failed_result():
    event_type, payload = _cma_shape(
        "tool_call_end",
        {
            "toolName": "ReadSessionEvents",
            "success": True,
            "output": '{"error": "read_session_events failed"}',
        },
    )

    assert event_type == "agent.tool_result"
    assert payload["tool_name"] == "ReadSessionEvents"
    assert payload["success"] is False
    assert payload["is_error"] is True
    assert payload["error"] == "read_session_events failed"


def test_runtime_config_payload_is_not_wrapped_or_audit_stamped():
    cloud_event = {
        "specversion": "1.0",
        "id": "session:sess-1:child-1:turn:1:runtime_config:hash",
        "type": "io.workflow-builder.session.runtime_config.v1",
        "data": {"configHash": "hash"},
    }

    event_type, payload = _cma_shape("session.runtime_config", cloud_event)

    assert event_type == "session.runtime_config"
    assert payload == cloud_event
    assert "_internalType" not in payload


def test_llm_start_and_usage_use_stable_source_ids(monkeypatch):
    published = []
    monkeypatch.setattr(
        events,
        "publish_session_event",
        lambda *args, **kwargs: published.append((args, kwargs)),
    )

    agent_config = {
        "model": "gemini-2.5-flash",
        "provider": "gemini",
        "component_name": "llm-gemini",
    }
    events.publish_adk_llm_start(_ctx(), agent_config)
    events.publish_adk_llm_usage(
        _ctx(),
        agent_config,
        {"input_tokens": 11, "output_tokens": 7},
        duration_ms=123.4,
    )

    assert [entry[0][1] for entry in published] == ["llm_start", "agent.llm_usage"]
    assert published[0][0][2]["model"] == "gemini-2.5-flash"
    assert published[0][1]["source_event_id"] == "adk:child-1:i1:llm_start"
    assert published[1][0][2]["input_tokens"] == 11
    assert published[1][0][2]["success"] is True
    assert published[1][1]["source_event_id"] == "adk:child-1:i1:llm_usage"


def test_tool_use_and_result_payloads_include_tool_call_id(monkeypatch):
    published = []
    monkeypatch.setattr(
        events,
        "publish_session_event",
        lambda *args, **kwargs: published.append((args, kwargs)),
    )

    events.publish_adk_tool_use(
        _ctx(),
        {"id": "call-1", "name": "Bash", "args": {"command": "pytest -q"}},
    )
    events.publish_adk_tool_result(
        _ctx(),
        {
            "tool_call_id": "call-1",
            "tool_name": "Bash",
            "result": {"exit_code": 0},
            "error": None,
        },
        duration_ms=42.0,
    )

    assert [entry[0][1] for entry in published] == [
        "agent.tool_use",
        "agent.tool_result",
    ]
    assert published[0][0][2]["tool_call_id"] == "call-1"
    assert published[0][0][2]["name"] == "Bash"
    assert published[0][0][2]["input"] == {"command": "pytest -q"}
    assert published[0][1]["source_event_id"] == "adk:child-1:i1:tool:call-1:tool_use"
    assert published[1][0][2]["tool_name"] == "Bash"
    assert published[1][0][2]["output"] == {"exit_code": 0}
    assert published[1][0][2]["success"] is True
    assert (
        published[1][1]["source_event_id"] == "adk:child-1:i1:tool:call-1:tool_result"
    )


def test_adk_tool_result_with_error_output_is_failed(monkeypatch):
    published = []
    monkeypatch.setattr(
        events,
        "publish_session_event",
        lambda *args, **kwargs: published.append((args, kwargs)),
    )

    events.publish_adk_tool_result(
        _ctx(),
        {
            "tool_call_id": "call-1",
            "tool_name": "ReadSessionEvents",
            "result": {"error": "read_session_events failed"},
        },
        duration_ms=5.0,
    )

    payload = published[0][0][2]
    assert payload["success"] is False
    assert payload["is_error"] is True
    assert payload["error"] == "read_session_events failed"


def test_event_actions_map_to_adk_event_types(monkeypatch):
    published = []
    monkeypatch.setattr(
        events,
        "publish_session_event",
        lambda *args, **kwargs: published.append((args, kwargs)),
    )

    class Actions:
        state_delta = {"phase": "done"}
        artifact_delta = {"report.md": 1}
        requested_auth_configs = {"call-1": {"scheme": "oauth"}}
        requested_tool_confirmations = {"call-1": {"message": "approve?"}}
        transfer_to_agent = "reviewer"
        escalate = True
        render_ui_widgets = [{"type": "form"}]

    events.publish_adk_event_actions(
        _ctx(),
        {"id": "call-1", "name": "Bash"},
        Actions(),
    )

    assert [entry[0][1] for entry in published] == [
        "adk.state_delta",
        "adk.artifact_delta",
        "adk.auth_request",
        "adk.tool_confirmation_request",
        "adk.transfer",
        "adk.escalation",
        "adk.ui_widget",
    ]
    assert published[0][0][2]["state_delta"] == {"phase": "done"}
    assert published[-1][0][2]["render_ui_widgets"] == [{"type": "form"}]
