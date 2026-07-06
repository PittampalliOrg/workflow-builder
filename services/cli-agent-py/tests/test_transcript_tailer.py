"""Transcript tailer tests with a synthetic Claude Code JSONL transcript."""

from __future__ import annotations

import asyncio
import json

from src.transcript_tailer import TailerManager, TranscriptTailer


def _assistant_line(uuid: str, text: str, *, model: str = "claude-opus-4-8") -> str:
    return json.dumps(
        {
            "type": "assistant",
            "uuid": uuid,
            "message": {
                "model": model,
                "content": [{"type": "text", "text": text}],
                "usage": {
                    "input_tokens": 11,
                    "output_tokens": 7,
                    "cache_read_input_tokens": 100,
                    "cache_creation_input_tokens": 5,
                },
            },
        }
    )


def _make_tailer(path):
    published: list[tuple[str | None, str, dict, str | None]] = []

    def publish(session_id, event_type, data, *, source_event_id=None, **_kw):
        published.append((session_id, event_type, data, source_event_id))

    return TranscriptTailer(str(path), "sess-1", publish=publish), published


def test_assistant_lines_emit_message_and_usage(tmp_path):
    path = tmp_path / "t.jsonl"
    path.write_text(
        "\n".join(
            [
                json.dumps({"type": "user", "message": {"content": "hi"}}),
                _assistant_line("u1", "hello!"),
                "not json at all",
                json.dumps({"type": "system", "subtype": "init"}),
            ]
        )
        + "\n"
    )
    tailer, published = _make_tailer(path)
    emitted = tailer.poll()
    assert emitted == 2
    (sid, etype, data, source_id) = published[0]
    assert (sid, etype) == ("sess-1", "agent.message")
    assert data["content"] == [{"type": "text", "text": "hello!"}]
    assert data["model"] == "claude-opus-4-8"
    assert source_id == "transcript:u1"
    (_, usage_type, usage_data, usage_source) = published[1]
    assert usage_type == "agent.llm_usage"
    # input_tokens pass through AS-IS (already net of cache reads).
    assert usage_data["input_tokens"] == 11
    assert usage_data["output_tokens"] == 7
    assert usage_data["cache_read_input_tokens"] == 100
    assert usage_data["cache_creation_input_tokens"] == 5
    assert usage_source == "transcript-usage:u1"
    assert tailer.last_assistant_text == "hello!"


def test_incremental_poll_only_emits_new_lines(tmp_path):
    path = tmp_path / "t.jsonl"
    path.write_text(_assistant_line("u1", "first") + "\n")
    tailer, published = _make_tailer(path)
    assert tailer.poll() == 2
    assert tailer.poll() == 0  # nothing new
    with open(path, "a") as handle:
        handle.write(_assistant_line("u2", "second") + "\n")
    assert tailer.poll() == 2
    assert published[-2][3] == "transcript:u2"
    assert tailer.last_assistant_text == "second"


def test_partial_trailing_line_is_buffered(tmp_path):
    path = tmp_path / "t.jsonl"
    full = _assistant_line("u9", "split write")
    path.write_text(full[:25])  # partial line, no newline
    tailer, published = _make_tailer(path)
    assert tailer.poll() == 0
    with open(path, "a") as handle:
        handle.write(full[25:] + "\n")
    assert tailer.poll() == 2
    assert published[0][2]["content"] == [{"type": "text", "text": "split write"}]


def test_missing_file_is_tolerated(tmp_path):
    tailer, published = _make_tailer(tmp_path / "missing.jsonl")
    assert tailer.poll() == 0
    assert published == []


def test_assistant_line_without_text_still_emits_usage(tmp_path):
    path = tmp_path / "t.jsonl"
    entry = {
        "type": "assistant",
        "uuid": "u3",
        "message": {
            "model": "claude-opus-4-8",
            "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}],
            "usage": {"input_tokens": 3, "output_tokens": 2},
        },
    }
    path.write_text(json.dumps(entry) + "\n")
    tailer, published = _make_tailer(path)
    assert tailer.poll() == 1
    assert published[0][1] == "agent.llm_usage"
    assert tailer.last_assistant_text is None


def test_drain_captures_late_final_line_over_stale_mid_turn(tmp_path):
    """The Stop-hook race: a stale mid-turn message is present when the drain
    starts, and the REAL final line (the verdict) is still being streamed. The
    drain must keep waiting through the streaming writes and end with the FINAL
    line as last_assistant_text — not the stale mid-turn one."""
    path = tmp_path / "t.jsonl"
    path.write_text(_assistant_line("u1", "mid-turn message") + "\n")
    _tailer, published = _make_tailer(path)
    manager = TailerManager()
    manager._tailer = _tailer

    async def scenario():
        # Prime: the tailer already holds the stale mid-turn message at Stop.
        await asyncio.to_thread(_tailer.flush)
        assert _tailer.last_assistant_text == "mid-turn message"

        async def stream_then_final():
            # Keep the transcript growing so the drain does not declare
            # quiescence early, then append the FINAL assistant line last.
            for i in range(3):
                await asyncio.sleep(0.12)
                with open(path, "a") as handle:
                    handle.write(json.dumps({"type": "progress", "i": i}) + "\n")
                    handle.flush()
            await asyncio.sleep(0.12)
            with open(path, "a") as handle:
                handle.write(_assistant_line("u2", "FINAL verdict message") + "\n")
                handle.flush()

        writer = asyncio.create_task(stream_then_final())
        await manager.drain_quiescent(max_wait=5, quiet_period=0.3, poll_seconds=0.05)
        await writer

    asyncio.run(scenario())
    assert _tailer.last_assistant_text == "FINAL verdict message"
    # The final agent.message was published (the verdict is not lost). Each
    # assistant line emits agent.message THEN agent.llm_usage, so look up the
    # message rather than the trailing event.
    messages = [data for _sid, etype, data, _src in published if etype == "agent.message"]
    assert messages[-1]["content"] == [{"type": "text", "text": "FINAL verdict message"}]


def test_drain_returns_promptly_when_already_quiescent(tmp_path):
    path = tmp_path / "t.jsonl"
    path.write_text(_assistant_line("u1", "done") + "\n")
    tailer, _published = _make_tailer(path)
    manager = TailerManager()
    manager._tailer = tailer

    async def scenario():
        loop = asyncio.get_running_loop()
        start = loop.time()
        # max_wait deliberately large: a quiescent file must NOT block for it.
        await manager.drain_quiescent(max_wait=5, quiet_period=0.2, poll_seconds=0.05)
        return loop.time() - start

    elapsed = asyncio.run(scenario())
    assert elapsed < 0.2 + 0.2  # ~quiet_period, not the 5s cap
    assert tailer.last_assistant_text == "done"


def test_drain_without_active_tailer_is_a_noop():
    manager = TailerManager()
    asyncio.run(manager.drain_quiescent(max_wait=1, quiet_period=0.1))


def test_adapter_transcript_mapping_can_raise_turn_completed(tmp_path):
    path = tmp_path / "agy.jsonl"
    path.write_text(
        json.dumps(
            {
                "source": "MODEL",
                "type": "PLANNER_RESPONSE",
                "status": "DONE",
                "step_index": 21,
                "content": "final agy answer",
            }
        )
        + "\n"
    )
    published: list[tuple[str | None, str, dict, str | None]] = []
    raised: list[list[dict]] = []

    class FakeAdapter:
        def map_transcript_entry(self, entry):
            return [
                {
                    "type": "agent.message",
                    "data": {
                        "content": [{"type": "text", "text": entry["content"]}],
                    },
                    "sourceEventId": f"fake:{entry['step_index']}",
                }
            ]

    def publish(session_id, event_type, data, *, source_event_id=None, **_kw):
        published.append((session_id, event_type, data, source_event_id))

    tailer = TranscriptTailer(
        str(path),
        "sess-1",
        publish=publish,
        adapter=FakeAdapter(),
        raise_lifecycle=lambda events: raised.append(events),
    )

    assert tailer.poll() == 1
    assert published == [
        (
            "sess-1",
            "agent.message",
            {"content": [{"type": "text", "text": "final agy answer"}]},
            "fake:21",
        )
    ]
    # Stop-hook-exclusive cutover: the tailer publishes CONTENT only and never
    # raises turn.completed from the transcript.
    assert raised == []
    assert tailer.last_assistant_text == "final agy answer"
    assert tailer.turn_completion_raised is False
