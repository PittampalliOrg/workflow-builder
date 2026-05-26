from __future__ import annotations

from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.session_native import (  # noqa: E402
    SESSION_WORKFLOW_STATE_KEY,
    build_continue_as_new_input,
    logical_turn_id,
    session_native_event_fields,
    session_workflow_instance_id,
    session_workflow_state_from_message,
    should_continue_session_as_new,
    terminal_stop_reason_from_events,
)


def test_session_workflow_instance_id_prefers_dapr_instance_id() -> None:
    assert session_workflow_instance_id("sess-1", "fallback") == "sess-1"
    assert session_workflow_instance_id("", "sess-2") == "sess-2"


def test_logical_turn_id_is_not_the_workflow_instance_id() -> None:
    assert logical_turn_id("sess-1", 3) == "sess-1:turn-3"
    assert session_native_event_fields("sess-1") == {
        "agentWorkflowMode": "session-native",
        "workflowInstanceId": "sess-1",
    }


def test_session_state_round_trips_continue_as_new_counters() -> None:
    state = session_workflow_state_from_message(
        {
            SESSION_WORKFLOW_STATE_KEY: {
                "turnCounter": "7",
                "configRevision": "3",
                "continuationCount": "2",
                "controlOverrideFields": ["modelSpec", "tools", ""],
            }
        }
    )

    assert state == {
        "turnCounter": 7,
        "configRevision": 3,
        "continuationCount": 2,
        "controlOverrideFields": ["modelSpec", "tools"],
    }


def test_continue_as_new_policy_ignores_one_shot_runs() -> None:
    should_continue, reason = should_continue_session_as_new(
        auto_terminate=True,
        turn_counter=100,
        compaction_runs=100,
        continue_as_new_turn_threshold=10,
        continue_as_new_after_compactions=1,
    )

    assert should_continue is False
    assert reason is None


def test_continue_as_new_policy_uses_turn_and_compaction_thresholds() -> None:
    assert should_continue_session_as_new(
        auto_terminate=False,
        turn_counter=10,
        compaction_runs=0,
        continue_as_new_turn_threshold=10,
        continue_as_new_after_compactions=None,
    ) == (True, "turn_threshold")
    assert should_continue_session_as_new(
        auto_terminate=False,
        turn_counter=2,
        compaction_runs=3,
        continue_as_new_turn_threshold=None,
        continue_as_new_after_compactions=3,
    ) == (True, "compaction_threshold")


def test_build_continue_as_new_input_carries_session_metadata_not_chat_state() -> None:
    next_input = build_continue_as_new_input(
        message={
            "sessionId": "sess-1",
            "agentConfig": {"modelSpec": "old"},
            "initialEvents": [{"type": "user.message"}],
        },
        agent_config={"modelSpec": "new"},
        pending_events=[],
        turn_counter=12,
        config_revision=4,
        control_override_fields={"modelSpec"},
        continuation_count=1,
        reason="turn_threshold",
    )

    assert next_input["sessionId"] == "sess-1"
    assert next_input["agentConfig"] == {"modelSpec": "new"}
    assert next_input["initialEvents"] == []
    assert next_input[SESSION_WORKFLOW_STATE_KEY] == {
        "turnCounter": 12,
        "configRevision": 4,
        "controlOverrideFields": ["modelSpec"],
        "continuationCount": 2,
        "lastContinueAsNewReason": "turn_threshold",
    }


def test_terminal_stop_reason_from_events_handles_interrupt_before_turn() -> None:
    assert terminal_stop_reason_from_events(
        [
            {"type": "user.interrupt"},
            {"type": "user.message", "content": [{"type": "text", "text": "hi"}]},
        ]
    ) == {"type": "interrupted"}


def test_terminal_stop_reason_from_events_handles_terminate_before_turn() -> None:
    assert terminal_stop_reason_from_events(
        [
            {
                "type": "session.terminate",
                "reason": "operator cleanup",
                "source": "benchmark_cleanup",
            }
        ]
    ) == {
        "type": "terminated",
        "reason": "operator cleanup",
        "source": "benchmark_cleanup",
    }


def test_terminal_stop_reason_from_events_ignores_normal_user_messages() -> None:
    assert (
        terminal_stop_reason_from_events(
            [{"type": "user.message", "content": [{"type": "text", "text": "hi"}]}]
        )
        is None
    )
