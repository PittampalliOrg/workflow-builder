"""Incremental CLI transcript (JSONL) tailer.

Claude Code writes its conversation transcript as JSONL; lines with
``.type == "assistant"`` carry ``.message.content`` blocks (text),
``.message.usage`` ``{input_tokens, output_tokens, cache_read_input_tokens,
cache_creation_input_tokens}`` and ``.message.model``. The tailer reads the
file incrementally by byte offset (tolerating partial trailing lines + unknown
line types) and mirrors:

  - ``agent.message`` with CMA content blocks, sourceEventId
    ``transcript:{entry uuid}`` (dedup across re-reads / pod restarts);
  - ``agent.llm_usage`` with input_tokens NET of cache reads (Claude Code's
    ``usage.input_tokens`` is already net — passed through AS-IS per the
    platform's llm_usage SYSTEM INVARIANT), sourceEventId
    ``transcript-usage:{entry uuid}``.

Adapters may override transcript-row mapping for runtimes whose native JSONL
schema is not Claude-shaped (for example Antigravity/agy).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Callable, Mapping

from src.event_publisher import publish_session_event

logger = logging.getLogger(__name__)

TAIL_POLL_SECONDS = float(os.environ.get("CLI_TRANSCRIPT_POLL_SECONDS", "2"))


def _text_of_content_blocks(blocks: Any) -> str:
    if isinstance(blocks, str):
        return blocks.strip()
    parts: list[str] = []
    if isinstance(blocks, list):
        for block in blocks:
            if isinstance(block, Mapping) and block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
    return "\n\n".join(parts)


class TranscriptTailer:
    def __init__(
        self,
        path: str,
        session_id: str | None,
        *,
        publish: Callable[..., None] = publish_session_event,
        adapter=None,
        raise_lifecycle: Callable[[list[dict[str, Any]]], None] | None = None,
    ):
        self.path = path
        self.session_id = session_id
        self._publish = publish
        self._adapter = adapter
        self._raise_lifecycle = raise_lifecycle
        self._offset = 0
        self._partial = b""
        self.last_assistant_text: str | None = None
        self.turn_completion_raised = False

    def poll(self) -> int:
        """Read newly-appended bytes and emit events for complete new lines.
        Returns the number of session events emitted."""
        try:
            with open(self.path, "rb") as handle:
                handle.seek(self._offset)
                data = handle.read()
        except FileNotFoundError:
            return 0
        except OSError as exc:
            logger.debug("[tailer] read failed for %s: %s", self.path, exc)
            return 0
        if not data:
            return 0
        self._offset += len(data)
        buffer = self._partial + data
        lines = buffer.split(b"\n")
        self._partial = lines.pop()  # trailing partial (b"" when data ends in \n)
        emitted = 0
        for raw_line in lines:
            emitted += self._handle_line(raw_line)
        return emitted

    def flush(self) -> int:
        return self.poll()

    def _handle_line(self, raw_line: bytes) -> int:
        text = raw_line.decode("utf-8", errors="replace").strip()
        if not text:
            return 0
        try:
            entry = json.loads(text)
        except (TypeError, ValueError):
            logger.debug("[tailer] skipping unparseable transcript line")
            return 0
        if not isinstance(entry, Mapping):
            return 0

        adapter_events = self._adapter_events(entry)
        if adapter_events is not None:
            return adapter_events

        return self._handle_claude_entry(entry)

    def _handle_claude_entry(self, entry: Mapping[str, Any]) -> int:
        if not isinstance(entry, Mapping) or entry.get("type") != "assistant":
            return 0  # tolerate unknown line types
        message = entry.get("message")
        if not isinstance(message, Mapping):
            return 0
        uuid = entry.get("uuid")
        uuid_text = str(uuid).strip() if uuid else None
        model = message.get("model")
        emitted = 0

        content_text = _text_of_content_blocks(message.get("content"))
        if content_text:
            self.last_assistant_text = content_text
            self._publish(
                self.session_id,
                "agent.message",
                {
                    # CMA shape: content is an array of typed blocks (matches
                    # the shared publisher's llm_complete translation).
                    "content": [{"type": "text", "text": content_text}],
                    "model": model,
                },
                source_event_id=f"transcript:{uuid_text}" if uuid_text else None,
            )
            emitted += 1

        usage = message.get("usage")
        if isinstance(usage, Mapping):
            self._publish(
                self.session_id,
                "agent.llm_usage",
                {
                    # Pass through AS-IS: Claude Code usage.input_tokens is
                    # already NET of cache reads (platform llm_usage invariant).
                    "input_tokens": usage.get("input_tokens"),
                    "output_tokens": usage.get("output_tokens"),
                    "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
                    "cache_creation_input_tokens": usage.get(
                        "cache_creation_input_tokens"
                    ),
                    "model": model,
                },
                source_event_id=f"transcript-usage:{uuid_text}" if uuid_text else None,
            )
            emitted += 1
        return emitted

    def _adapter_events(self, entry: Mapping[str, Any]) -> int | None:
        adapter = self._adapter
        if adapter is None:
            return None
        try:
            events = adapter.map_transcript_entry(entry)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[tailer] adapter transcript mapping failed: %s", exc)
            events = None
        if events is None:
            return None

        emitted = 0
        for event in events:
            if not isinstance(event, Mapping):
                continue
            event_type = event.get("type")
            if not isinstance(event_type, str) or not event_type:
                continue
            data = event.get("data")
            payload = dict(data) if isinstance(data, Mapping) else {}
            if event_type == "agent.message":
                text = _text_of_content_blocks(payload.get("content"))
                if text:
                    self.last_assistant_text = text
            source_event_id = event.get("sourceEventId") or event.get("source_event_id")
            self._publish(
                self.session_id,
                event_type,
                payload,
                source_event_id=str(source_event_id) if source_event_id else None,
            )
            emitted += 1

        self._raise_adapter_completion(entry)
        return emitted

    def _raise_adapter_completion(self, entry: Mapping[str, Any]) -> None:
        if self._adapter is None or self._raise_lifecycle is None:
            return
        try:
            event = self._adapter.transcript_turn_completion(entry)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[tailer] adapter transcript completion failed: %s", exc)
            return
        if not isinstance(event, Mapping) or event.get("type") != "turn.completed":
            return
        payload = dict(event)
        text = payload.get("lastAssistantText") or payload.get("content")
        if isinstance(text, str) and text.strip():
            self.last_assistant_text = text.strip()
        self.turn_completion_raised = True
        self._raise_lifecycle([payload])


class TailerManager:
    """Owns the active tailer + its polling task (one CLI session per pod)."""

    def __init__(self):
        self._tailer: TranscriptTailer | None = None
        self._task: asyncio.Task | None = None

    def start(
        self,
        path: str | None,
        session_id: str | None,
        *,
        publish: Callable[..., None] = publish_session_event,
        adapter=None,
        raise_lifecycle: Callable[[list[dict[str, Any]]], None] | None = None,
    ) -> TranscriptTailer | None:
        if not path:
            return None
        if self._tailer is not None and self._tailer.path == path:
            if adapter is not None:
                self._tailer._adapter = adapter
            if raise_lifecycle is not None:
                self._tailer._raise_lifecycle = raise_lifecycle
            return self._tailer
        self.stop()
        self._tailer = TranscriptTailer(
            path,
            session_id,
            publish=publish,
            adapter=adapter,
            raise_lifecycle=raise_lifecycle,
        )
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is not None:
            self._task = loop.create_task(self._poll_loop(self._tailer))
        return self._tailer

    def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None
        self._tailer = None

    def current(self) -> TranscriptTailer | None:
        return self._tailer

    def flush_now(self) -> None:
        if self._tailer is not None:
            self._tailer.flush()

    async def wait_for_assistant_text(
        self, *, timeout: float, poll_seconds: float = 0.2
    ) -> str | None:
        """Poll until the active transcript has assistant text or timeout.

        Some CLIs fire their Stop hook before the final transcript line is
        fully flushed. The durable workflow should see turn.completed only after
        the tailer has had a short chance to publish the final agent.message.
        """
        tailer = self._tailer
        if tailer is None:
            return None
        if tailer.last_assistant_text:
            return tailer.last_assistant_text
        deadline = asyncio.get_running_loop().time() + max(0.0, timeout)
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.to_thread(tailer.flush)
            if tailer.last_assistant_text:
                return tailer.last_assistant_text
            await asyncio.sleep(max(0.01, poll_seconds))
        await asyncio.to_thread(tailer.flush)
        return tailer.last_assistant_text

    async def _poll_loop(self, tailer: TranscriptTailer) -> None:
        while True:
            await asyncio.sleep(TAIL_POLL_SECONDS)
            try:
                await asyncio.to_thread(tailer.poll)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.debug("[tailer] poll failed: %s", exc)


_manager = TailerManager()


def get_tailer_manager() -> TailerManager:
    return _manager
