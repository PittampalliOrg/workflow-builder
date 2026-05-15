from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.event_publisher import _cma_shape  # noqa: E402


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
