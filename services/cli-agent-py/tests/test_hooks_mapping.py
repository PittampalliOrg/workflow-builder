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
    assert events == [
        {
            "type": "user.message",
            "data": {"content": [{"type": "text", "text": "hello there"}]},
        }
    ]


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
        self.turn_sources: list[str] = []
        self.turn_started_count = 1
        self.injected_prompts: set[str] = set()

    def get_session(self):
        return {
            "sessionId": "sess-1",
            "instanceId": "inst-1",
            "paneRef": "p1",
            "turnStartedCount": self.turn_started_count,
        }

    def register_transcript(self, path, cli_session_id):
        self.transcripts.append((path, cli_session_id))

    def note_turn_started(self, source):
        self.turn_sources.append(source)
        self.turn_started_count += 1
        return self.turn_started_count

    def consume_injected_prompt(self, prompt):
        if prompt not in self.injected_prompts:
            return False
        self.injected_prompts.discard(prompt)
        return True


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
    response = asyncio.run(processor.process(_hook("Stop")))
    assert response == {}
    assert manager.tailer.flushes == 1
    assert raised == [
        ("inst-1", [{"type": "turn.completed", "lastAssistantText": "final answer"}])
    ]


def test_duplicate_stop_hook_does_not_raise_second_completion_for_same_turn():
    processor, _published, raised, supervisor, manager = _processor()

    asyncio.run(processor.process(_hook("Stop")))
    asyncio.run(processor.process(_hook("Stop")))

    assert manager.tailer.flushes == 2
    assert raised == [
        ("inst-1", [{"type": "turn.completed", "lastAssistantText": "final answer"}])
    ]

    supervisor.note_turn_started("next")
    asyncio.run(processor.process(_hook("Stop")))

    assert raised == [
        ("inst-1", [{"type": "turn.completed", "lastAssistantText": "final answer"}]),
        ("inst-1", [{"type": "turn.completed", "lastAssistantText": "final answer"}]),
    ]


def test_agy_stop_hook_continues_when_output_contract_missing(tmp_path, monkeypatch):
    from src.cli_adapters import get_adapter

    monkeypatch.setenv("AGENT_LOCAL_SANDBOX_ROOT", str(tmp_path))
    monkeypatch.setenv("CLI_AGENT_AGY_HOME_OVERRIDE", str(tmp_path))
    adapter = get_adapter("antigravity")
    adapter.seed(
        {
            "agentConfig": {"runtime": "agy-cli", "cliAdapter": "antigravity"},
            "outputSync": {
                "paths": [{"source": str(tmp_path / "app"), "target": "/sandbox/app"}]
            },
            "body": {
                "stopCondition": "Stop only after index.html exists.",
                "requireFileChanges": True,
            },
        }
    )
    published: list[tuple[str | None, str, dict]] = []
    raised: list[tuple[str, list[dict]]] = []
    processor = HookProcessor(
        publish=lambda sid, etype, data, **kw: published.append((sid, etype, data)),
        raise_lifecycle=lambda iid, events: raised.append((iid, events)),
        supervisor_getter=lambda: FakeSupervisor(),
        tailer_manager=FakeTailerManager(),
        adapter=adapter,
    )

    response = asyncio.run(processor.process(_hook("Stop")))

    assert response["decision"] == "continue"
    assert "Missing required path" in response["reason"]
    assert raised == []
    assert published == [
        (
            "sess-1",
            "hook.decision",
            {
                "hook_event": "Stop",
                "decision": "continue",
                "reason": response["reason"],
            },
        )
    ]


def test_session_end_raises_cli_session_end():
    processor, _published, raised, _supervisor, _manager = _processor()
    asyncio.run(processor.process(_hook("SessionEnd", reason="logout")))
    assert raised == [("inst-1", [{"type": "cli.session_end", "reason": "logout"}])]


def test_adapter_specific_completion_hook_raises_turn_completed():
    class FakeAdapter:
        def is_turn_completion_hook(self, event_name):
            return event_name == "PostTurn"

        def extract_completion_text(self, payload):
            return payload.get("response")

        def map_hook_event(self, payload):
            return []

    published: list[tuple[str | None, str, dict]] = []
    raised: list[tuple[str, list[dict]]] = []
    class NoTailerManager:
        def current(self):
            return None

        def flush_now(self):
            return None

        def start(self, path, session_id, **kwargs):
            return None

    processor = HookProcessor(
        publish=lambda sid, etype, data, **kw: published.append((sid, etype, data)),
        raise_lifecycle=lambda iid, events: raised.append((iid, events)),
        supervisor_getter=lambda: FakeSupervisor(),
        tailer_manager=NoTailerManager(),
        adapter=FakeAdapter(),
    )
    asyncio.run(processor.process(_hook("PostTurn", response="adapter final")))
    assert raised == [
        ("inst-1", [{"type": "turn.completed", "lastAssistantText": "adapter final"}])
    ]


def test_mapped_events_publish_under_wfb_session_id():
    processor, published, _raised, supervisor, _manager = _processor()
    asyncio.run(processor.process(_hook("UserPromptSubmit", prompt="hi")))
    assert published == [
        ("sess-1", "user.message", {"content": [{"type": "text", "text": "hi"}]})
    ]
    assert supervisor.turn_sources == ["hook:UserPromptSubmit"]


def test_injected_user_prompt_submit_is_not_double_published():
    processor, published, raised, supervisor, _manager = _processor()
    supervisor.injected_prompts.add("seed prompt")

    asyncio.run(processor.process(_hook("UserPromptSubmit", prompt="seed prompt")))

    assert published == []
    assert raised == []
    assert supervisor.turn_sources == []
    assert supervisor.injected_prompts == set()


def test_hook_owned_injected_user_prompt_submit_records_turn_without_duplicate_message():
    class HookOwnedAdapter:
        hook_reports_prompt_submit = True

        def is_turn_completion_hook(self, event_name):
            return False

        def map_hook_event(self, payload):
            return []

    published: list[tuple[str | None, str, dict]] = []
    raised: list[tuple[str, list[dict]]] = []
    supervisor = FakeSupervisor()
    supervisor.injected_prompts.add("seed prompt")
    processor = HookProcessor(
        publish=lambda sid, etype, data, **kw: published.append((sid, etype, data)),
        raise_lifecycle=lambda iid, events: raised.append((iid, events)),
        supervisor_getter=lambda: supervisor,
        tailer_manager=FakeTailerManager(),
        adapter=HookOwnedAdapter(),
    )

    asyncio.run(processor.process(_hook("UserPromptSubmit", prompt=" seed prompt\n")))

    assert published == []
    assert raised == []
    assert supervisor.turn_sources == ["hook:UserPromptSubmit"]
    assert supervisor.injected_prompts == set()


def test_post_tool_use_flattens_bash_response_object():
    """Bash tool_response is {stdout, stderr, ...} — `output` must be a STRING
    (the tool views render it verbatim; objects show '(no output)' — observed
    live on the first mirrored turn)."""
    events = map_hook_event(
        _hook(
            "PostToolUse",
            tool_name="Bash",
            tool_response={
                "stdout": "wfb-e2e-42",
                "stderr": "",
                "interrupted": False,
                "isImage": False,
            },
        )
    )
    data = events[0]["data"]
    assert data["output"] == "wfb-e2e-42"
    assert data["output_preview"] == "wfb-e2e-42"
    assert data["name"] == "Bash"


def test_processor_registers_tailer_from_any_hook_payload():
    """transcript_path rides EVERY hook payload; the tailer must start even if
    SessionStart never fires (live failure mode: matcher-suppressed)."""
    import asyncio

    from src.hooks_api import HookProcessor

    class FakeManager:
        def __init__(self):
            self.started = []

        def current(self):
            return None

        def start(self, path, session_id, **kw):
            self.started.append((path, session_id))

        def flush_now(self):
            pass

    manager = FakeManager()
    published = []
    proc = HookProcessor(
        publish=lambda sid, etype, data, **kw: published.append(etype),
        raise_lifecycle=lambda *_a, **_k: None,
        supervisor_getter=lambda: None,
        tailer_manager=manager,
    )
    asyncio.run(
        proc.process(
            _hook(
                "UserPromptSubmit",
                prompt="hi",
                transcript_path="/sandbox/.claude/projects/-sandbox/x.jsonl",
            )
        )
    )
    assert manager.started == [
        ("/sandbox/.claude/projects/-sandbox/x.jsonl", None)
    ]
    assert "user.message" in published
