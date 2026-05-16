from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.event_publisher import _cma_shape  # noqa: E402


class _ImmediateThread:
    def __init__(self, target, args=(), daemon=None):
        self.target = target
        self.args = args

    def start(self):
        self.target(*self.args)


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


def test_tool_call_end_with_error_text_output_is_failed_result():
    event_type, payload = _cma_shape(
        "tool_call_end",
        {
            "toolName": "NotebookEdit",
            "success": True,
            "output": "Error: cell_id is required for replace and delete operations.",
        },
    )

    assert event_type == "agent.tool_result"
    assert payload["success"] is False
    assert payload["error"] == "Error: cell_id is required for replace and delete operations."


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


def test_publish_session_event_preserves_explicit_trace_context(monkeypatch):
    from src import event_publisher

    captured = []
    monkeypatch.setattr(event_publisher.threading, "Thread", _ImmediateThread)
    monkeypatch.setattr(
        event_publisher,
        "_post_ingest",
        lambda session_id, envelope: captured.append((session_id, envelope)),
    )

    publish_data = {
        "traceId": "explicit-trace",
        "spanId": "explicit-span",
    }
    event_publisher.publish_session_event(
        "session-1",
        "agent.llm_usage",
        publish_data,
        source_event_id="source-1",
    )

    assert captured[0][0] == "session-1"
    assert captured[0][1]["data"]["traceId"] == "explicit-trace"
    assert captured[0][1]["data"]["spanId"] == "explicit-span"


def test_publish_session_event_stamps_missing_trace_context(monkeypatch):
    from src import event_publisher
    from src.telemetry import session_tracing

    captured = []
    monkeypatch.setattr(event_publisher.threading, "Thread", _ImmediateThread)
    monkeypatch.setattr(
        event_publisher,
        "_post_ingest",
        lambda session_id, envelope: captured.append((session_id, envelope)),
    )
    monkeypatch.setattr(
        session_tracing,
        "get_current_trace_context",
        lambda: ("ambient-trace", "ambient-span"),
    )

    event_publisher.publish_session_event(
        "session-1",
        "agent.llm_usage",
        {},
        source_event_id="source-2",
    )

    assert captured[0][1]["data"]["traceId"] == "ambient-trace"
    assert captured[0][1]["data"]["spanId"] == "ambient-span"


def test_publish_session_event_stamps_context_usage_fields(monkeypatch):
    from src import event_publisher

    captured = []
    monkeypatch.setattr(event_publisher.threading, "Thread", _ImmediateThread)
    monkeypatch.setattr(
        event_publisher,
        "_post_ingest",
        lambda session_id, envelope: captured.append((session_id, envelope)),
    )

    event_publisher.publish_session_event(
        "session-1",
        "agent.llm_usage",
        {
            "model": "claude-sonnet-4-6",
            "input_tokens": 80_000,
            "cache_read_input_tokens": 10_000,
            "cache_creation_input_tokens": 10_000,
        },
        source_event_id="source-context",
    )

    data = captured[0][1]["data"]
    assert data["context_window_size"] == 200_000
    assert data["context_input_tokens"] == 100_000
    assert data["context_used_percentage"] == 50
    assert data["context_remaining_percentage"] == 50
    assert data["context_source"] == "provider_usage"
    assert data["context_count_method"] == "provider_usage"
    assert data["context_count_scope"] == "last_provider_call"
