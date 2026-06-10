"""Fixture-driven tests for the Claude Code hook → session-event mapping."""

from __future__ import annotations

import asyncio
from typing import Any

from src.hooks_api import (
    INJECTION_MARKER,
    HookProcessor,
    TOOL_OUTPUT_TRUNCATE_BYTES,
    map_hook_event,
)


def _hook(name: str, **fields: Any) -> dict[str, Any]:
    return {
        "session_id": "cli-sess-1",
        "transcript_path": "/tmp/transcript.jsonl",
        "cwd": "/sandbox",
        "permission_mode": "default",
        "hook_event_name": name,
        **fields,
    }


def test_user_prompt_submit_maps_to_user_message():
    events = map_hook_event(_hook("UserPromptSubmit", prompt="hello there"))
    assert events == [{"type": "user.message", "data": {"content": "hello there"}}]


def test_injected_prompt_is_skipped():
    events = map_hook_event(
        _hook("UserPromptSubmit", prompt=f"{INJECTION_MARKER}continue the goal")
    )
    assert events == []


def test_pre_tool_use_maps_to_tool_use():
    events = map_hook_event(
        _hook("PreToolUse", tool_name="Bash", tool_input={"command": "ls"})
    )
    assert len(events) == 1
    assert events[0]["type"] == "agent.tool_use"
    assert events[0]["data"]["tool_name"] == "Bash"
    assert events[0]["data"]["tool_input"] == {"command": "ls"}
    assert events[0]["data"]["name"] == "Bash"
    assert events[0]["data"]["input"] == {"command": "ls"}


def test_post_tool_use_truncates_output():
    big = "x" * (TOOL_OUTPUT_TRUNCATE_BYTES + 500)
    events = map_hook_event(
        _hook("PostToolUse", tool_name="Bash", tool_response=big)
    )
    assert events[0]["type"] == "agent.tool_result"
    data = events[0]["data"]
    assert data["ok"] is True
    assert len(data["output"].encode()) <= TOOL_OUTPUT_TRUNCATE_BYTES


def test_post_tool_use_failure_maps_to_failed_result():
    events = map_hook_event(
        _hook("PostToolUseFailure", tool_name="Bash", tool_response="boom", error="exit 1")
    )
    data = events[0]["data"]
    assert events[0]["type"] == "agent.tool_result"
    assert data["ok"] is False
    assert data["is_error"] is True
    assert data["error"] == "exit 1"


def test_permission_request_emits_decision_and_blocked_nudge():
    events = map_hook_event(_hook("PermissionRequest", tool_name="Write"))
    assert [event["type"] for event in events] == ["hook.decision", "session.status_idle"]
    assert events[0]["data"] == {"decision": "ask", "tool_name": "Write"}
    assert events[1]["data"] == {"blocked": True, "reason": "permission_prompt"}


def test_permission_denied_decision():
    events = map_hook_event(_hook("PermissionDenied", tool_name="Write"))
    assert events[0]["data"]["decision"] == "deny"


def test_unknown_and_side_effect_events_map_to_nothing():
    assert map_hook_event(_hook("SessionStart", source="startup")) == []
    assert map_hook_event(_hook("Stop")) == []
    assert map_hook_event(_hook("SessionEnd", reason="exit")) == []
    assert map_hook_event(_hook("Notification")) == []
    assert map_hook_event({"no_hook_event_name": True}) == []


# ---------------------------------------------------------------------------
# HookProcessor side effects
# ---------------------------------------------------------------------------


class FakeSupervisor:
    def __init__(self):
        self.transcripts: list[tuple[str | None, str | None]] = []

    def get_session(self):
        return {"sessionId": "sess-1", "instanceId": "inst-1", "paneRef": "p1"}

    def register_transcript(self, path, cli_session_id):
        self.transcripts.append((path, cli_session_id))


class FakeTailer:
    def __init__(self):
        self.flushes = 0
        self.last_assistant_text = "final answer"

    def flush(self):
        self.flushes += 1


class FakeTailerManager:
    def __init__(self):
        self.started: list[tuple[str, str | None]] = []
        self.tailer = FakeTailer()

    def start(self, path, session_id, **_kwargs):
        self.started.append((path, session_id))
        return self.tailer

    def current(self):
        return self.tailer

    def flush_now(self):
        self.tailer.flush()


def _processor():
    published: list[tuple[str | None, str, dict]] = []
    raised: list[tuple[str, list[dict]]] = []
    supervisor = FakeSupervisor()
    manager = FakeTailerManager()
    processor = HookProcessor(
        publish=lambda sid, etype, data, **kw: published.append((sid, etype, data)),
        raise_lifecycle=lambda iid, events: raised.append((iid, events)),
        supervisor_getter=lambda: supervisor,
        tailer_manager=manager,
    )
    return processor, published, raised, supervisor, manager


def test_session_start_registers_transcript_and_starts_tailer():
    processor, published, raised, supervisor, manager = _processor()
    asyncio.run(
        processor.process(
            _hook("SessionStart", source="startup", transcript_path="/tmp/t.jsonl")
        )
    )
    assert supervisor.transcripts == [("/tmp/t.jsonl", "cli-sess-1")]
    assert manager.started == [("/tmp/t.jsonl", "sess-1")]
    assert published == []
    assert raised == []


def test_stop_flushes_tailer_then_raises_turn_completed():
    processor, published, raised, _supervisor, manager = _processor()
    asyncio.run(processor.process(_hook("Stop")))
    assert manager.tailer.flushes == 1
    assert raised == [
        ("inst-1", [{"type": "turn.completed", "lastAssistantText": "final answer"}])
    ]


def test_session_end_raises_cli_session_end():
    processor, _published, raised, _supervisor, _manager = _processor()
    asyncio.run(processor.process(_hook("SessionEnd", reason="logout")))
    assert raised == [("inst-1", [{"type": "cli.session_end", "reason": "logout"}])]


def test_mapped_events_publish_under_wfb_session_id():
    processor, published, _raised, _supervisor, _manager = _processor()
    asyncio.run(processor.process(_hook("UserPromptSubmit", prompt="hi")))
    assert published == [("sess-1", "user.message", {"content": "hi"})]
