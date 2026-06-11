"""Claude Code http-hook receiver (POST /internal/hooks/claude) + the pure
hook-payload → session-event mapping.

The image's /etc/claude-code/managed-settings.json wires every hook event to
``http://127.0.0.1:8002/internal/hooks/claude``. Claude Code http-hook input
JSON: ``{session_id, transcript_path, cwd, permission_mode, hook_event_name,
...event fields (tool_name, tool_input, tool_response, prompt, source,
reason)}``. The endpoint responds ``{}`` 200 immediately and processes
asynchronously.

Mapping (defaults; the CLI adapter's ``map_hook_event`` can override):
  UserPromptSubmit   → user.message {content}      (skipped for injected prompts)
  PreToolUse         → agent.tool_use {tool_name, tool_input (+ name/input aliases)}
  PostToolUse        → agent.tool_result {tool_name, ok: true, output ≤16KB}
  PostToolUseFailure → agent.tool_result {tool_name, ok: false, ...}
  PermissionRequest  → hook.decision {decision: "ask"} + session.status_idle {blocked}
  PermissionDenied   → hook.decision {decision: "deny"} + session.status_idle {blocked}
  SessionStart       → (side effect) register transcript + start tailer
  Stop               → (side effect) flush tailer; raise {type: "turn.completed"}
  SessionEnd         → (side effect) raise {type: "cli.session_end", reason}

NOTE: fastapi MUST be imported at module level — this module uses
``from __future__ import annotations`` and FastAPI resolves handler
annotations against module globals; a function-local ``Request`` import
degrades the parameter to a required query field and 422s every hook POST
(same bug class as terminal_ws.py, found live on ryzen 2026-06-10).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable, Mapping

from fastapi import APIRouter, Request

from src.event_publisher import publish_session_event
from src.session_supervisor import get_supervisor
from src.taskhub import raise_lifecycle_events
from src.transcript_tailer import get_tailer_manager

logger = logging.getLogger(__name__)

# Invisible prefix stamped on prompts injected into the TUI by the raise-event
# endpoint (user.message → pane.send_text). The UserPromptSubmit hook skips
# prompts carrying it so goal-loop continuations (already recorded as
# user.message rows by the BFF driver) are not double-published.
# ZWSP + WORD JOINER + ZWSP: invisible in the TUI, never typed by a human.
INJECTION_MARKER = "\u200b\u2060\u200b"

TOOL_OUTPUT_TRUNCATE_BYTES = 16 * 1024


def _clean(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _truncate_output(value: Any) -> Any:
    """Cap tool output payloads at 16KB (stringify non-str values when large)."""
    if value is None:
        return None
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value)
        except (TypeError, ValueError):
            text = str(value)
        if len(text.encode("utf-8", errors="replace")) <= TOOL_OUTPUT_TRUNCATE_BYTES:
            return value  # small structured outputs pass through untouched
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= TOOL_OUTPUT_TRUNCATE_BYTES:
        return text
    return encoded[:TOOL_OUTPUT_TRUNCATE_BYTES].decode("utf-8", errors="replace")


def _flatten_tool_output(tool_response: Any) -> str:
    """Flatten a hook ``tool_response`` to display text. Bash-style responses
    are Mappings ``{stdout, stderr, interrupted, …}`` — prefer stdout (+stderr
    when non-empty); other shapes fall back to str/JSON."""
    if tool_response is None:
        return ""
    if isinstance(tool_response, str):
        return tool_response
    if isinstance(tool_response, Mapping):
        stdout = tool_response.get("stdout")
        stderr = tool_response.get("stderr")
        if isinstance(stdout, str) or isinstance(stderr, str):
            parts = []
            if isinstance(stdout, str) and stdout.strip():
                parts.append(stdout.rstrip("\n"))
            if isinstance(stderr, str) and stderr.strip():
                parts.append(f"[stderr]\n{stderr.rstrip(chr(10))}")
            return "\n".join(parts)
        content = tool_response.get("content")
        if isinstance(content, str):
            return content
    try:
        return json.dumps(tool_response)
    except (TypeError, ValueError):
        return str(tool_response)


def map_hook_event(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Pure mapping of one Claude Code hook payload to publishable session
    events ``[{type, data}]``. Side-effect-only events (SessionStart/Stop/
    SessionEnd) return [] — HookProcessor handles them."""
    name = _clean(payload.get("hook_event_name"))
    if not name:
        return []
    tool_name = _clean(payload.get("tool_name"))

    if name == "UserPromptSubmit":
        prompt = payload.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            return []
        if prompt.startswith(INJECTION_MARKER):
            return []  # injected via raise-event; already recorded by the BFF
        # CMA shape: content is an ARRAY of typed blocks — the /sessions
        # event-row renderer joins block .text and shows "(no content)" for a
        # bare string (observed live on the first mirrored turn).
        return [
            {
                "type": "user.message",
                "data": {"content": [{"type": "text", "text": prompt}]},
            }
        ]

    if name == "PreToolUse":
        tool_input = payload.get("tool_input")
        return [
            {
                "type": "agent.tool_use",
                "data": {
                    "tool_name": tool_name,
                    "tool_input": tool_input,
                    # CMA aliases the /sessions UI reads (publisher emits
                    # name/input for tool_call_start; we publish agent.tool_use
                    # directly so we stamp both spellings).
                    "name": tool_name,
                    "input": tool_input if isinstance(tool_input, Mapping) else {},
                },
            }
        ]

    if name == "PostToolUse":
        output_text = _flatten_tool_output(payload.get("tool_response"))
        return [
            {
                "type": "agent.tool_result",
                "data": {
                    "tool_name": tool_name,
                    "name": tool_name,
                    "ok": True,
                    "success": True,
                    # dapr-agent-py tool_call_end parity: `output` is a STRING
                    # (the tool views render it verbatim; an object shows
                    # "(no output)") + a 500-char `output_preview`.
                    "output": _truncate_output(output_text),
                    "output_preview": output_text[:500] if output_text else "",
                },
            }
        ]

    if name == "PostToolUseFailure":
        output_text = _flatten_tool_output(payload.get("tool_response"))
        return [
            {
                "type": "agent.tool_result",
                "data": {
                    "tool_name": tool_name,
                    "name": tool_name,
                    "ok": False,
                    "success": False,
                    "is_error": True,
                    "output": _truncate_output(output_text),
                    "output_preview": output_text[:500] if output_text else "",
                    "error": _clean(payload.get("error"))
                    or _clean(payload.get("reason"))
                    or "tool failed",
                },
            }
        ]

    if name in ("PermissionRequest", "PermissionDenied"):
        decision = "ask" if name == "PermissionRequest" else "deny"
        return [
            {
                "type": "hook.decision",
                "data": {"decision": decision, "tool_name": tool_name},
            },
            {
                "type": "session.status_idle",
                "data": {"blocked": True, "reason": "permission_prompt"},
            },
        ]

    # SessionStart / Stop / SessionEnd / Notification / PreCompact etc. are
    # side-effect-only or intentionally unmapped.
    return []


class HookProcessor:
    def __init__(
        self,
        *,
        publish: Callable[..., None] = publish_session_event,
        raise_lifecycle: Callable[[str, list[dict[str, Any]]], None] = raise_lifecycle_events,
        supervisor_getter: Callable[[], Any] = get_supervisor,
        tailer_manager=None,
        adapter=None,
    ):
        self._publish = publish
        self._raise_lifecycle = raise_lifecycle
        self._supervisor_getter = supervisor_getter
        self._tailer_manager = tailer_manager or get_tailer_manager()
        self._adapter = adapter

    def _session(self) -> dict[str, Any]:
        supervisor = self._supervisor_getter()
        if supervisor is None:
            return {}
        try:
            return supervisor.get_session() or {}
        except Exception:  # noqa: BLE001
            return {}

    async def process(self, payload: Mapping[str, Any]) -> None:
        if not isinstance(payload, Mapping):
            return
        name = _clean(payload.get("hook_event_name"))
        session = self._session()
        session_id = session.get("sessionId")
        instance_id = session.get("instanceId")

        # EVERY hook payload carries transcript_path — register the tailer
        # opportunistically from any event, never only from SessionStart
        # (observed live: SessionStart did not fire under the early
        # managed-settings matcher shape, so the tailer never started and no
        # agent.message/llm_usage were mirrored).
        self._register_transcript(payload, session_id)

        if name == "SessionStart":
            return  # registration handled above; no published event

        if name == "Stop":
            await asyncio.to_thread(self._tailer_manager.flush_now)
            tailer = self._tailer_manager.current()
            last_text = tailer.last_assistant_text if tailer is not None else None
            if instance_id:
                event: dict[str, Any] = {"type": "turn.completed"}
                if last_text:
                    event["lastAssistantText"] = last_text
                await asyncio.to_thread(self._safe_raise, instance_id, [event])
            return

        if name == "SessionEnd":
            await asyncio.to_thread(self._tailer_manager.flush_now)
            if instance_id:
                event = {
                    "type": "cli.session_end",
                    "reason": _clean(payload.get("reason")) or "session_end",
                }
                await asyncio.to_thread(self._safe_raise, instance_id, [event])
            return

        events = None
        if self._adapter is not None:
            try:
                events = self._adapter.map_hook_event(payload)
            except Exception as exc:  # noqa: BLE001
                logger.debug("[hooks] adapter mapping failed: %s", exc)
        if events is None:
            events = map_hook_event(payload)
        for event in events:
            self._publish(session_id, event["type"], event.get("data") or {})

    def _register_transcript(
        self, payload: Mapping[str, Any], session_id: Any
    ) -> None:
        transcript_path = _clean(payload.get("transcript_path"))
        if not transcript_path:
            return
        current = self._tailer_manager.current()
        if current is not None and getattr(current, "path", None) == transcript_path:
            return
        cli_session_id = _clean(payload.get("session_id"))
        supervisor = self._supervisor_getter()
        if supervisor is not None:
            try:
                supervisor.register_transcript(transcript_path, cli_session_id)
            except Exception:  # noqa: BLE001
                pass
        self._tailer_manager.start(transcript_path, session_id)
        logger.info("[hooks] transcript tailer started for %s", transcript_path)

    def _safe_raise(self, instance_id: str, events: list[dict[str, Any]]) -> None:
        try:
            self._raise_lifecycle(instance_id, events)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[hooks] raise lifecycle failed for %s: %s", instance_id, exc)


_processor: HookProcessor | None = None


def get_processor() -> HookProcessor:
    global _processor
    if _processor is None:
        _processor = HookProcessor()
    return _processor


def build_router():
    """Build the FastAPI router for the Claude Code http-hook receiver."""
    router = APIRouter()

    @router.post("/internal/hooks/claude")
    async def claude_hook(request: Request) -> dict[str, Any]:
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            payload = {}
        if isinstance(payload, dict):
            # Respond {} immediately; process out-of-band.
            asyncio.get_running_loop().create_task(get_processor().process(payload))
        return {}

    return router
