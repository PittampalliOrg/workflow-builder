from __future__ import annotations

import os
import sys


root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

from src.session_config import (  # noqa: E402
    SESSION_CONFIG_UPDATE_EVENT,
    apply_agent_config_patch,
    apply_session_control_events,
    external_control_event_as_user_event,
    session_control_event_to_patch,
)


def test_update_agent_config_event_extracts_patch() -> None:
    patch = session_control_event_to_patch(
        {
            "type": SESSION_CONFIG_UPDATE_EVENT,
            "patch": {
                "modelSpec": "openai/o3",
                "builtinTools": ["read_file", "write_file"],
                "ignored": "value",
            },
        }
    )

    assert patch == {
        "modelSpec": "openai/o3",
        "builtinTools": ["read_file", "write_file"],
        "tools": ["read_file", "write_file"],
    }


def test_legacy_model_event_maps_to_config_patch() -> None:
    patch = session_control_event_to_patch(
        {"type": "session.control.set_model", "modelSpec": "openai/o3"}
    )

    assert patch == {"modelSpec": "openai/o3"}


def test_control_events_are_applied_and_removed_from_pending_events() -> None:
    next_config, remaining, applied = apply_session_control_events(
        {"modelSpec": "anthropic/claude-opus-4-7", "tools": ["read_file"]},
        [
            {
                "type": SESSION_CONFIG_UPDATE_EVENT,
                "patch": {
                    "modelSpec": "openai/o3",
                    "tools": ["read_file", "write_file"],
                },
            },
            {"type": "user.message", "content": [{"type": "text", "text": "hi"}]},
        ],
    )

    assert next_config["modelSpec"] == "openai/o3"
    assert next_config["tools"] == ["read_file", "write_file"]
    assert remaining == [
        {"type": "user.message", "content": [{"type": "text", "text": "hi"}]}
    ]
    assert applied == [
        {
            "type": SESSION_CONFIG_UPDATE_EVENT,
            "changedKeys": ["modelSpec", "tools"],
        }
    ]


def test_apply_agent_config_patch_does_not_mutate_original_config() -> None:
    original = {"modelSpec": "openai/o3", "tools": ["read_file"]}
    next_config, changed = apply_agent_config_patch(
        original,
        {"tools": ["write_file"]},
    )

    assert original == {"modelSpec": "openai/o3", "tools": ["read_file"]}
    assert next_config["tools"] == ["write_file"]
    assert changed == ["tools"]


def test_external_control_event_maps_to_user_event_lane() -> None:
    event_name, payload = external_control_event_as_user_event(
        SESSION_CONFIG_UPDATE_EVENT,
        {"patch": {"modelSpec": "openai/o3"}},
    )

    assert event_name == "session.user_events"
    assert payload == {
        "events": [
            {
                "type": SESSION_CONFIG_UPDATE_EVENT,
                "patch": {"modelSpec": "openai/o3"},
            }
        ]
    }


def test_external_terminate_event_maps_to_user_event_lane() -> None:
    event_name, payload = external_control_event_as_user_event(
        "session.terminate",
        {"reason": "operator cleanup", "source": "benchmark_cleanup"},
    )

    assert event_name == "session.user_events"
    assert payload == {
        "events": [
            {
                "type": "session.terminate",
                "reason": "operator cleanup",
                "source": "benchmark_cleanup",
            }
        ]
    }
