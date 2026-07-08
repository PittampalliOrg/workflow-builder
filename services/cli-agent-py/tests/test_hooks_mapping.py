"""Fixture-driven tests for the Claude Code hook → session-event mapping."""

from __future__ import annotations

import asyncio
import time
from typing import Any

from src.cli_adapters import get_adapter
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


def test_mcp_tool_hooks_include_server_metadata():
    use_events = map_hook_event(
        _hook(
            "PreToolUse",
            tool_name="mcp__piece_github__find_user",
            tool_input={"username": "vpittamp"},
        )
    )
    use_data = use_events[0]["data"]
    assert use_data["server"] == "piece_github"
    assert use_data["mcp_tool"] == "find_user"

    result_events = map_hook_event(
        _hook(
            "PostToolUse",
            tool_name="mcp__piece_github__find_user",
            tool_response="ok",
        )
    )
    result_data = result_events[0]["data"]
    assert result_data["server"] == "piece_github"
    assert result_data["mcp_tool"] == "find_user"


def test_anonymous_empty_tool_hook_is_skipped():
    assert map_hook_event(_hook("PreToolUse")) == []
    assert map_hook_event(_hook("PostToolUse")) == []


def test_anonymous_tool_hook_with_payload_gets_stable_name():
    events = map_hook_event(_hook("PreToolUse", tool_input={"path": "file.txt"}))
    assert events[0]["data"]["tool_name"] == "unknown_tool"
    assert events[0]["data"]["name"] == "unknown_tool"
    assert events[0]["data"]["input"] == {"path": "file.txt"}


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
    assert map_hook_event({"no_hook_event_name": True}) == []


def test_notification_maps_to_session_notification():
    events = map_hook_event(
        _hook(
            "Notification",
            message="waiting for input",
            level="info",
            notificationType="status",
        )
    )

    assert events == [
        {
            "type": "session.notification",
            "data": {
                "message": "waiting for input",
                "level": "info",
                "notificationType": "status",
            },
        }
    ]


# ---------------------------------------------------------------------------
# HookProcessor side effects
# ---------------------------------------------------------------------------


class FakeSupervisor:
    def __init__(self):
        self.transcripts: list[tuple[str | None, str | None]] = []
        self.turn_sources: list[str] = []
        self.turn_started_count = 1
        self.injected_prompts: set[str] = set()
        self.suppress_idle_calls = 0
        self.one_shot = False
        self.agent_config: dict[str, Any] = {}
        self.structured_output: dict[str, Any] | None = None
        self.structured_output_text: str | None = None
        self.structured_output_attempts = 0
        self.structured_output_feedback: str | None = None

    def get_session(self):
        return {
            "sessionId": "sess-1",
            "instanceId": "inst-1",
            "paneRef": "p1",
            "turnStartedCount": self.turn_started_count,
            "oneShot": self.one_shot,
            "agentConfig": self.agent_config,
            "structuredOutput": self.structured_output,
            "structuredOutputText": self.structured_output_text,
            "structuredOutputAttempts": self.structured_output_attempts,
            "structuredOutputFeedback": self.structured_output_feedback,
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

    def suppress_next_idle_status(self):
        self.suppress_idle_calls += 1

    def record_structured_output(self, value, canonical_text):
        self.structured_output = dict(value)
        self.structured_output_text = canonical_text

    def note_structured_output_retry(self, feedback):
        self.structured_output_attempts += 1
        self.structured_output_feedback = feedback
        return self.structured_output_attempts


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


class DelayedTailer(FakeTailer):
    def __init__(self):
        super().__init__()
        self.last_assistant_text = None

    def flush(self):
        self.flushes += 1
        if self.flushes >= 2:
            self.last_assistant_text = "delayed final answer"


class DelayedTailerManager(FakeTailerManager):
    def __init__(self):
        super().__init__()
        self.tailer = DelayedTailer()

    async def wait_for_assistant_text(self, *, timeout, poll_seconds):
        while self.tailer.flushes < 2:
            self.tailer.flush()
            await asyncio.sleep(0)
        return self.tailer.last_assistant_text


def _processor(adapter=None):
    published: list[tuple[str | None, str, dict]] = []
    raised: list[tuple[str, list[dict]]] = []
    supervisor = FakeSupervisor()
    manager = FakeTailerManager()
    processor = HookProcessor(
        publish=lambda sid, etype, data, **kw: published.append((sid, etype, data)),
        raise_lifecycle=lambda iid, events: raised.append((iid, events)),
        supervisor_getter=lambda: supervisor,
        tailer_manager=manager,
        adapter=adapter,
    )
    return processor, published, raised, supervisor, manager


def _claude_processor():
    """A processor wired with the REAL claude adapter, which DECLARES the
    StopFailure turn-failure edge (``is_turn_failure_hook``). The shared
    HookProcessor keys the failure branch off that adapter method, so the failure
    edge is only exercised when an adapter opts in (mirrors the completion edge)."""
    return _processor(adapter=get_adapter("claude-code"))


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
    processor, published, raised, supervisor, manager = _processor()
    response = asyncio.run(processor.process(_hook("Stop")))
    assert response == {}
    assert manager.tailer.flushes == 1
    assert supervisor.suppress_idle_calls == 1
    assert published == [
        (
            "sess-1",
            "agent.message",
            {"content": [{"type": "text", "text": "final answer"}]},
        )
    ]
    assert raised == [
        ("inst-1", [{"type": "turn.completed", "lastAssistantText": "final answer"}])
    ]


def test_stop_canonicalizes_structured_output_before_completion():
    processor, published, raised, supervisor, manager = _processor()
    supervisor.one_shot = True
    supervisor.agent_config = {
        "structuredOutputMode": "stopHook",
        "responseJsonSchema": {
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
            "additionalProperties": False,
        },
    }
    manager.tailer.last_assistant_text = '```json\n{"answer":"yes"}\n```'

    response = asyncio.run(processor.process(_hook("Stop")))

    assert response == {}
    assert supervisor.structured_output == {"answer": "yes"}
    assert supervisor.structured_output_text == '{"answer": "yes"}'
    assert ("sess-1", "structured_output.validation", {"ok": True, "source": "assistant_text"}) in published
    assert raised == [
        (
            "inst-1",
            [
                {
                    "type": "turn.completed",
                    "lastAssistantText": '{"answer": "yes"}',
                    "structuredOutput": {"answer": "yes"},
                    "structuredOutputText": '{"answer": "yes"}',
                }
            ],
        )
    ]


def test_stop_continues_until_structured_output_is_valid():
    processor, published, raised, supervisor, manager = _processor()
    supervisor.one_shot = True
    supervisor.agent_config = {
        "structuredOutputMode": "stopHook",
        "responseJsonSchema": {
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
        },
    }
    manager.tailer.last_assistant_text = "plain prose"

    response = asyncio.run(processor.process(_hook("Stop")))

    assert response["decision"] == "continue"
    assert "Structured output validation failed" in response["reason"]
    assert "Return only the corrected JSON object" in response["reason"]
    assert raised == []
    assert supervisor.structured_output_attempts == 1
    assert any(
        etype == "structured_output.validation" and data["ok"] is False
        for _sid, etype, data in published
    )
    assert any(
        etype == "hook.decision"
        and data["decision"] == "continue"
        and data["source"] == "structured-output-stop-hook"
        for _sid, etype, data in published
    )


def test_structured_output_tool_call_is_captured_when_present():
    processor, published, _raised, supervisor, _manager = _processor()
    supervisor.one_shot = True
    supervisor.agent_config = {
        "structuredOutputMode": "tool",
        "responseJsonSchema": {
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
        },
    }

    response = asyncio.run(
        processor.process(
            _hook(
                "PostToolUse",
                tool_name="StructuredOutput",
                tool_input={"answer": "yes"},
                tool_response="ok",
            )
        )
    )

    assert response == {}
    assert supervisor.structured_output == {"answer": "yes"}
    assert supervisor.structured_output_text == '{"answer": "yes"}'
    assert ("sess-1", "structured_output.validation", {"ok": True, "source": "tool_call"}) in published


def test_stop_records_missing_turn_start_before_completion():
    published: list[tuple[str | None, str, dict]] = []
    raised: list[tuple[str, list[dict]]] = []
    supervisor = FakeSupervisor()
    supervisor.turn_started_count = 0
    processor = HookProcessor(
        publish=lambda sid, etype, data, **kw: published.append((sid, etype, data)),
        raise_lifecycle=lambda iid, events: raised.append((iid, events)),
        supervisor_getter=lambda: supervisor,
        tailer_manager=FakeTailerManager(),
    )

    asyncio.run(processor.process(_hook("Stop")))

    assert supervisor.turn_sources == ["hook:completion-fallback"]
    assert raised == [
        ("inst-1", [{"type": "turn.completed", "lastAssistantText": "final answer"}])
    ]


def test_late_injected_submit_does_not_duplicate_fallback_turn_start():
    _published: list[tuple[str | None, str, dict]] = []
    raised: list[tuple[str, list[dict]]] = []
    supervisor = FakeSupervisor()
    supervisor.turn_started_count = 0
    supervisor.injected_prompts.add("seed prompt")
    processor = HookProcessor(
        publish=lambda sid, etype, data, **kw: _published.append((sid, etype, data)),
        raise_lifecycle=lambda iid, events: raised.append((iid, events)),
        supervisor_getter=lambda: supervisor,
        tailer_manager=FakeTailerManager(),
    )

    asyncio.run(processor.process(_hook("Stop")))
    asyncio.run(processor.process(_hook("UserPromptSubmit", prompt="seed prompt")))

    assert supervisor.turn_sources == ["hook:completion-fallback"]


def test_stop_hook_can_be_transcript_only_without_duplicate_completion():
    class TranscriptOnlyAdapter:
        def stop_hook_completes_turn(self):
            return False

        def is_turn_completion_hook(self, event_name):
            return False

        def is_turn_failure_hook(self, event_name):
            return False

        def extract_completion_text(self, payload):
            return "should not raise"

        def map_hook_event(self, payload):
            return []

    published: list[tuple[str | None, str, dict]] = []
    raised: list[tuple[str, list[dict]]] = []
    manager = FakeTailerManager()
    manager.tailer.turn_completion_raised = True
    processor = HookProcessor(
        publish=lambda sid, etype, data, **kw: published.append((sid, etype, data)),
        raise_lifecycle=lambda iid, events: raised.append((iid, events)),
        supervisor_getter=lambda: FakeSupervisor(),
        tailer_manager=manager,
        adapter=TranscriptOnlyAdapter(),
    )

    response = asyncio.run(processor.process(_hook("Stop")))

    assert response == {}
    assert manager.tailer.flushes == 1
    assert raised == []


def test_stop_waits_for_delayed_transcript_before_turn_completed():
    published: list[tuple[str | None, str, dict]] = []
    raised: list[tuple[str, list[dict]]] = []
    manager = DelayedTailerManager()
    processor = HookProcessor(
        publish=lambda sid, etype, data, **kw: published.append((sid, etype, data)),
        raise_lifecycle=lambda iid, events: raised.append((iid, events)),
        supervisor_getter=lambda: FakeSupervisor(),
        tailer_manager=manager,
    )

    asyncio.run(processor.process(_hook("Stop")))

    assert manager.tailer.flushes >= 2
    assert raised == [
        (
            "inst-1",
            [{"type": "turn.completed", "lastAssistantText": "delayed final answer"}],
        )
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


def test_processor_publishes_adapter_internal_events_and_strips_response():
    class AdapterWithResponse:
        name = "antigravity"

        def is_turn_completion_hook(self, event_name):
            return False

        def is_turn_failure_hook(self, event_name):
            return False

        def map_hook_event(self, payload):
            return [
                {
                    "type": "agent.tool_use",
                    "data": {"tool_name": "run_command"},
                }
            ]

        def hook_response(self, event_name, payload, session):
            return {
                "decision": "deny",
                "reason": "captured output",
                "_workflowBuilderEvents": [
                    {
                        "type": "agent.tool_result",
                        "data": {"tool_name": "run_command", "ok": True},
                    }
                ],
            }

    published: list[tuple[str | None, str, dict]] = []
    processor = HookProcessor(
        publish=lambda sid, etype, data, **kw: published.append((sid, etype, data)),
        raise_lifecycle=lambda *_a, **_k: None,
        supervisor_getter=lambda: FakeSupervisor(),
        tailer_manager=FakeTailerManager(),
        adapter=AdapterWithResponse(),
    )

    response = asyncio.run(processor.process(_hook("PreToolUse")))

    assert response == {"decision": "deny", "reason": "captured output"}
    assert published == [
        ("sess-1", "agent.tool_use", {"tool_name": "run_command"}),
        ("sess-1", "agent.tool_result", {"tool_name": "run_command", "ok": True}),
    ]


def test_processor_keeps_event_loop_responsive_during_blocking_hook_response():
    class BlockingAdapter:
        name = "blocking-adapter"

        def is_turn_completion_hook(self, event_name):
            return False

        def is_turn_failure_hook(self, event_name):
            return False

        def map_hook_event(self, payload):
            return []

        def hook_response(self, event_name, payload, session):
            time.sleep(0.2)
            return {"decision": "deny", "reason": "blocking response finished"}

    processor = HookProcessor(
        publish=lambda *_a, **_k: None,
        raise_lifecycle=lambda *_a, **_k: None,
        supervisor_getter=lambda: FakeSupervisor(),
        tailer_manager=FakeTailerManager(),
        adapter=BlockingAdapter(),
    )

    async def run_check():
        task = asyncio.create_task(processor.process(_hook("PreToolUse")))
        await asyncio.sleep(0.02)
        assert not task.done()
        return await task

    response = asyncio.run(run_check())

    assert response == {
        "decision": "deny",
        "reason": "blocking response finished",
    }


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


def test_stop_drains_late_final_transcript_line_into_turn_completed(tmp_path, monkeypatch):
    """End-to-end race regression: a stale mid-turn message is present when the
    Stop hook fires, and the REAL final line (the machine-parsed verdict) is
    still streaming to the transcript. turn.completed MUST carry the FINAL line,
    not the stale mid-turn one (which corrupted GAN critic verdicts)."""
    import json as _json

    import src.hooks_api as hooks_api
    from src.transcript_tailer import TailerManager, TranscriptTailer

    # Keep the drain fast but still span the simulated stream.
    monkeypatch.setattr(hooks_api, "STOP_DRAIN_QUIET_SECONDS", 0.3)
    monkeypatch.setattr(hooks_api, "STOP_DRAIN_POLL_SECONDS", 0.05)
    monkeypatch.setattr(hooks_api, "STOP_DRAIN_MAX_SECONDS", 5)

    def _line(uuid: str, text: str) -> str:
        return _json.dumps(
            {
                "type": "assistant",
                "uuid": uuid,
                "message": {
                    "model": "claude-opus-4-8",
                    "content": [{"type": "text", "text": text}],
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                },
            }
        )

    path = tmp_path / "t.jsonl"
    path.write_text(_line("u1", "mid-turn message") + "\n")

    published: list[tuple[str, dict]] = []
    raised: list[tuple[str, list[dict]]] = []

    def publish(sid, etype, data, **_kw):
        published.append((etype, data))

    manager = TailerManager()
    manager._tailer = TranscriptTailer(str(path), "sess-1", publish=publish)
    processor = HookProcessor(
        publish=publish,
        raise_lifecycle=lambda iid, events: raised.append((iid, events)),
        supervisor_getter=lambda: FakeSupervisor(),
        tailer_manager=manager,
    )

    async def scenario():
        await asyncio.to_thread(manager._tailer.flush)  # stale message present at Stop
        assert manager._tailer.last_assistant_text == "mid-turn message"

        async def stream_then_final():
            for i in range(3):
                await asyncio.sleep(0.1)
                with open(path, "a") as handle:
                    handle.write(_json.dumps({"type": "progress", "i": i}) + "\n")
                    handle.flush()
            await asyncio.sleep(0.1)
            with open(path, "a") as handle:
                handle.write(_line("u2", "FINAL verdict message") + "\n")
                handle.flush()

        writer = asyncio.create_task(stream_then_final())
        # transcript_path must match the registered tailer's path, else the
        # per-hook _register_transcript would swap in a fresh tailer.
        await processor.process(_hook("Stop", transcript_path=str(path)))
        await writer

    asyncio.run(scenario())

    assert raised == [
        (
            "inst-1",
            [{"type": "turn.completed", "lastAssistantText": "FINAL verdict message"}],
        )
    ]
    # The final agent.message was published by the tailer BEFORE turn.completed
    # was raised, and the Stop branch did not re-publish a duplicate.
    agent_messages = [data for etype, data in published if etype == "agent.message"]
    assert agent_messages[-1]["content"] == [
        {"type": "text", "text": "FINAL verdict message"}
    ]
    assert len(agent_messages) == 2  # mid-turn + final, no hook-side duplicate


def test_pretooluse_ask_user_question_denied_in_one_shot_session():
    processor, published, raised, supervisor, _manager = _processor()
    supervisor.one_shot = True

    response = asyncio.run(
        processor.process(_hook("PreToolUse", tool_name="AskUserQuestion"))
    )

    # Blocking deny in both the generic and claude hookSpecificOutput shapes.
    assert response["decision"] == "block"
    assert response["hookSpecificOutput"]["hookEventName"] == "PreToolUse"
    assert response["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert "headless automated run" in response["reason"]
    assert "no human present" in response["hookSpecificOutput"]["permissionDecisionReason"]
    # A hook.decision is mirrored; the tool never runs (no agent.tool_use), and
    # no turn completion is raised.
    assert published == [
        (
            "sess-1",
            "hook.decision",
            {
                "hook_event": "PreToolUse",
                "decision": "deny",
                "reason": response["reason"],
                "tool_name": "AskUserQuestion",
                "source": "one-shot-ask-guard",
            },
        )
    ]
    assert raised == []


def test_pretooluse_ask_user_question_allowed_in_interactive_session():
    processor, published, _raised, supervisor, _manager = _processor()
    assert supervisor.one_shot is False  # interactive default

    response = asyncio.run(
        processor.process(_hook("PreToolUse", tool_name="AskUserQuestion"))
    )

    # Not denied: default (empty) response and the tool_use is mirrored normally.
    assert response.get("decision") != "block"
    assert any(etype == "agent.tool_use" for _sid, etype, _data in published)


def test_pretooluse_other_tool_not_denied_in_one_shot_session():
    """The guard is scoped to AskUserQuestion — other tools run normally even in
    a one-shot run (they don't wait on a human)."""
    processor, published, _raised, supervisor, _manager = _processor()
    supervisor.one_shot = True

    response = asyncio.run(
        processor.process(_hook("PreToolUse", tool_name="Bash", tool_input={"command": "ls"}))
    )

    assert response.get("decision") != "block"
    assert any(etype == "agent.tool_use" for _sid, etype, _data in published)


def test_session_end_raises_cli_session_end():
    processor, _published, raised, _supervisor, _manager = _processor()
    asyncio.run(processor.process(_hook("SessionEnd", reason="logout")))
    assert raised == [("inst-1", [{"type": "cli.session_end", "reason": "logout"}])]


def test_adapter_specific_completion_hook_raises_turn_completed():
    class FakeAdapter:
        def is_turn_completion_hook(self, event_name):
            return event_name == "PostTurn"

        def is_turn_failure_hook(self, event_name):
            return False

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

        def is_turn_failure_hook(self, event_name):
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


# ---------------------------------------------------------------------------
# StopFailure → turn.failed edge (W3a)
# ---------------------------------------------------------------------------


def test_stop_failure_raises_turn_failed_with_error_text():
    processor, _published, raised, supervisor, manager = _claude_processor()
    response = asyncio.run(processor.process(_hook("StopFailure", error="model overloaded")))
    assert response == {}
    # Drained like Stop; supervisor idle echo suppressed so the failure isn't
    # masked by a stale idle mirror.
    assert manager.tailer.flushes == 1
    assert supervisor.suppress_idle_calls == 1
    assert raised == [
        (
            "inst-1",
            [
                {
                    "type": "turn.failed",
                    "error": "model overloaded",
                    "lastAssistantText": "final answer",
                }
            ],
        )
    ]


def test_stop_failure_error_text_falls_back_to_reason():
    processor, _published, raised, _supervisor, _manager = _claude_processor()
    asyncio.run(processor.process(_hook("StopFailure", reason="max turns exceeded")))
    assert raised == [
        (
            "inst-1",
            [
                {
                    "type": "turn.failed",
                    "error": "max turns exceeded",
                    "lastAssistantText": "final answer",
                }
            ],
        )
    ]


def test_stop_then_stop_failure_same_turn_deduped():
    """Stop wins the turn first → its completion key blocks a same-turn StopFailure
    (whichever edge lands first wins; the other no-ops)."""
    processor, _published, raised, _supervisor, _manager = _claude_processor()
    asyncio.run(processor.process(_hook("Stop")))
    asyncio.run(processor.process(_hook("StopFailure", error="boom")))
    assert raised == [
        ("inst-1", [{"type": "turn.completed", "lastAssistantText": "final answer"}])
    ]


def test_stop_failure_then_stop_same_turn_deduped():
    """StopFailure lands first → its completion key blocks a same-turn Stop."""
    processor, _published, raised, _supervisor, _manager = _claude_processor()
    asyncio.run(processor.process(_hook("StopFailure", error="boom")))
    asyncio.run(processor.process(_hook("Stop")))
    assert raised == [
        (
            "inst-1",
            [{"type": "turn.failed", "error": "boom", "lastAssistantText": "final answer"}],
        )
    ]


def test_subagent_stop_failure_is_ignored():
    """A finishing subagent (Task tool) writes its transcript under .../subagents/
    — its StopFailure must NOT end the parent turn."""
    processor, _published, raised, _supervisor, _manager = _claude_processor()
    response = asyncio.run(
        processor.process(
            _hook(
                "StopFailure",
                error="boom",
                transcript_path="/sandbox/.claude/projects/-x/subagents/sub.jsonl",
            )
        )
    )
    assert response == {}
    assert raised == []


def test_subagent_stop_is_ignored():
    processor, _published, raised, _supervisor, _manager = _claude_processor()
    asyncio.run(
        processor.process(
            _hook(
                "Stop",
                transcript_path="/sandbox/.claude/projects/-x/subagents/sub.jsonl",
            )
        )
    )
    assert raised == []


def test_subagent_hook_does_not_repoint_the_tailer():
    """The subagent guard runs BEFORE _register_transcript, so a subagent
    Stop/StopFailure must NOT re-point the tailer at the subagent transcript
    (which would then mirror subagent content as the parent's)."""
    sub_path = "/sandbox/.claude/projects/-x/subagents/sub.jsonl"
    processor, _published, raised, _supervisor, manager = _claude_processor()
    asyncio.run(processor.process(_hook("Stop", transcript_path=sub_path)))
    asyncio.run(processor.process(_hook("StopFailure", error="x", transcript_path=sub_path)))
    assert manager.started == []  # tailer never started/re-pointed at the subagent
    assert raised == []


def test_stop_failure_ignored_entirely_when_flag_disabled(monkeypatch):
    import src.hooks_api as hooks_api

    monkeypatch.setattr(hooks_api, "CLI_TURN_FAILED_EDGE_ENABLED", False)
    processor, published, raised, _supervisor, _manager = _claude_processor()
    response = asyncio.run(processor.process(_hook("StopFailure", error="boom")))
    assert response == {}
    assert raised == []
    assert all(etype != "turn.failed" for _sid, etype, _data in published)


# ---------------------------------------------------------------------------
# background_task_count instrumentation (data only; no drain / behavior change)
# ---------------------------------------------------------------------------


def test_count_live_background_tasks_absent_or_non_list_returns_none():
    from src.hooks_api import _count_live_background_tasks

    # Absent / None / non-list is "no data" (None) — NOT a genuine zero.
    assert _count_live_background_tasks({}) is None
    assert _count_live_background_tasks({"background_tasks": None}) is None
    assert _count_live_background_tasks({"background_tasks": "oops"}) is None
    assert _count_live_background_tasks({"background_tasks": {"status": "running"}}) is None


def test_count_live_background_tasks_counts_unknown_status_as_live():
    from src.hooks_api import _count_live_background_tasks

    tasks = [
        {"status": "running"},   # live
        {"status": "COMPLETED"},  # terminal (case-insensitive)
        {"status": " killed "},   # terminal (stripped)
        {"status": "queued"},    # unknown → live
        {"status": None},        # non-string status → live
        {},                       # missing status key → live
        "not-a-dict",            # non-dict entry → live
    ]
    # running + queued + None + {} + "not-a-dict" = 5 live; COMPLETED + killed = terminal.
    assert _count_live_background_tasks({"background_tasks": tasks}) == 5


def test_count_live_background_tasks_all_terminal_returns_zero():
    from src.hooks_api import _count_live_background_tasks

    tasks = [
        {"status": "completed"},
        {"status": "failed"},
        {"status": "stopped"},
        {"status": "killed"},
    ]
    assert _count_live_background_tasks({"background_tasks": tasks}) == 0


def test_count_live_background_tasks_empty_list_is_zero_not_none():
    from src.hooks_api import _count_live_background_tasks

    assert _count_live_background_tasks({"background_tasks": []}) == 0


def test_stop_turn_completed_carries_background_task_count():
    processor, _published, raised, _supervisor, _manager = _processor()
    asyncio.run(
        processor.process(
            _hook(
                "Stop",
                background_tasks=[
                    {"status": "running"},    # live
                    {"status": "completed"},  # terminal
                    {},                        # unknown status → live
                ],
            )
        )
    )
    assert raised == [
        (
            "inst-1",
            [
                {
                    "type": "turn.completed",
                    "lastAssistantText": "final answer",
                    "backgroundTaskCount": 2,
                }
            ],
        )
    ]


def test_stop_without_background_tasks_omits_count():
    processor, _published, raised, _supervisor, _manager = _processor()
    asyncio.run(processor.process(_hook("Stop")))
    assert raised == [
        ("inst-1", [{"type": "turn.completed", "lastAssistantText": "final answer"}])
    ]
    assert "backgroundTaskCount" not in raised[0][1][0]


def test_stop_all_terminal_background_tasks_carries_zero_count():
    """A genuine zero (all tasks terminal) rides as 0 — distinct from the absent
    (no-data) case, which omits the field."""
    processor, _published, raised, _supervisor, _manager = _processor()
    asyncio.run(
        processor.process(_hook("Stop", background_tasks=[{"status": "completed"}]))
    )
    assert raised[0][1][0]["backgroundTaskCount"] == 0


def test_stop_failure_does_not_carry_background_task_count():
    """The failure edge never carries the count — a failed turn's background state
    is not meaningful, and only the completion edge computes it."""
    processor, _published, raised, _supervisor, _manager = _claude_processor()
    asyncio.run(
        processor.process(
            _hook("StopFailure", error="boom", background_tasks=[{"status": "running"}])
        )
    )
    assert raised == [
        (
            "inst-1",
            [
                {
                    "type": "turn.failed",
                    "error": "boom",
                    "lastAssistantText": "final answer",
                }
            ],
        )
    ]
    assert "backgroundTaskCount" not in raised[0][1][0]


def test_stop_omits_background_task_count_when_flag_disabled(monkeypatch):
    import src.hooks_api as hooks_api

    monkeypatch.setattr(hooks_api, "CLI_BACKGROUND_TASK_COUNT_ENABLED", False)
    processor, _published, raised, _supervisor, _manager = _processor()
    asyncio.run(
        processor.process(_hook("Stop", background_tasks=[{"status": "running"}]))
    )
    assert raised == [
        ("inst-1", [{"type": "turn.completed", "lastAssistantText": "final answer"}])
    ]
    assert "backgroundTaskCount" not in raised[0][1][0]
