"""CLI hook receivers + pure hook-payload → session-event mapping.

The image's /etc/claude-code/managed-settings.json wires every hook event to
``http://127.0.0.1:8002/internal/hooks/claude``. Claude Code http-hook input
JSON: ``{session_id, transcript_path, cwd, permission_mode, hook_event_name,
...event fields (tool_name, tool_input, tool_response, prompt, source,
reason)}``. The endpoint responds ``{}`` 200 immediately and processes
asynchronously.

Mapping (defaults; the CLI adapter's ``map_hook_event`` can override):
  UserPromptSubmit   → user.message {content}      (skipped for injected prompts;
                       hook-owned adapters still record turn_started)
  PreToolUse         → agent.tool_use {tool_name, tool_input (+ name/input aliases)}
  PostToolUse        → agent.tool_result {tool_name, ok: true, output ≤16KB}
  PostToolUseFailure → agent.tool_result {tool_name, ok: false, ...}
  PermissionRequest  → hook.decision {decision: "ask"} + session.status_idle {blocked}
  PermissionDenied   → hook.decision {decision: "deny"} + session.status_idle {blocked}
  SessionStart       → (side effect) register transcript + start tailer
  Stop               → (side effect) flush tailer; raise {type: "turn.completed"}
  SessionEnd         → (side effect) raise {type: "cli.session_end", reason}

Codex and Antigravity command hooks use the generic
``/internal/hooks/cli/{adapter}`` endpoint through the per-session relay script
their adapters materialize. They share the same normalized event stream and use
their adapter's ``is_turn_completion_hook`` method to decide which hook ends a
workflow turn.

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
import os
from typing import Any, Callable, Mapping

from fastapi import APIRouter, Request

from src.cli_adapters import get_adapter
from src.event_publisher import publish_session_event
from src.session_supervisor import get_supervisor
from src.taskhub import raise_lifecycle_events
from src.transcript_tailer import get_tailer_manager

logger = logging.getLogger(__name__)

# Invisible prefix stamped on prompts injected into the TUI by the raise-event
# endpoint (user.message → pane.send_text). The UserPromptSubmit hook skips
# prompts carrying it so goal-loop continuations (already recorded as
# user.message rows by the BFF driver) are not double-published. Adapters that
# cannot safely receive this marker use the supervisor's prompt digest ledger
# instead.
# ZWSP + WORD JOINER + ZWSP: invisible in the TUI, never typed by a human.
INJECTION_MARKER = "\u200b\u2060\u200b"

TOOL_OUTPUT_TRUNCATE_BYTES = 16 * 1024
COMPLETION_TEXT_WAIT_SECONDS = float(
    os.environ.get("CLI_COMPLETION_TEXT_WAIT_SECONDS", "3")
)
COMPLETION_TEXT_POLL_SECONDS = float(
    os.environ.get("CLI_COMPLETION_TEXT_POLL_SECONDS", "0.2")
)


def _clean(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _turn_started_count(session: Mapping[str, Any]) -> int:
    value = session.get("turnStartedCount")
    if isinstance(value, bool):
        return 0
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, str):
        try:
            parsed = int(value)
        except ValueError:
            return 0
        return parsed if parsed >= 0 else 0
    return 0


def _hook_name(payload: Mapping[str, Any]) -> str | None:
    for key in ("hook_event_name", "eventName", "event", "hookName", "name"):
        picked = _clean(payload.get(key))
        if picked:
            return picked
    return None


def _text_from_blocks(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str) and item.strip():
                parts.append(item.strip())
            elif isinstance(item, Mapping):
                text = item.get("text") or item.get("content")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
        if parts:
            return "\n\n".join(parts)
    return None


def _generic_completion_text(payload: Mapping[str, Any]) -> str | None:
    """Extract common "final response" shapes from hook payloads.

    Provider CLIs do not use one schema. Keep this deliberately conservative and
    only inspect keys that plausibly carry assistant output.
    """
    for key in (
        "lastAssistantText",
        "assistantText",
        "finalResponse",
        "response",
        "output",
        "content",
        "message",
        "text",
    ):
        value = payload.get(key)
        text = _text_from_blocks(value)
        if text:
            return text
        if isinstance(value, Mapping):
            nested = _generic_completion_text(value)
            if nested:
                return nested
    return None


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


def _mcp_tool_metadata(tool_name: str) -> dict[str, str]:
    if not tool_name.startswith("mcp__"):
        return {}
    parts = tool_name.split("__", 2)
    if len(parts) != 3 or not parts[1] or not parts[2]:
        return {}
    return {"server": parts[1], "mcp_tool": parts[2]}


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
    name = _hook_name(payload)
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
        if not tool_name and tool_input is None:
            return []
        normalized_tool_name = tool_name or "unknown_tool"
        return [
            {
                "type": "agent.tool_use",
                "data": {
                    "tool_name": normalized_tool_name,
                    "tool_input": tool_input,
                    # CMA aliases the /sessions UI reads (publisher emits
                    # name/input for tool_call_start; we publish agent.tool_use
                    # directly so we stamp both spellings).
                    "name": normalized_tool_name,
                    "input": tool_input if isinstance(tool_input, Mapping) else {},
                    **_mcp_tool_metadata(normalized_tool_name),
                },
            }
        ]

    if name == "PostToolUse":
        output_text = _flatten_tool_output(payload.get("tool_response"))
        if not tool_name and not output_text:
            return []
        normalized_tool_name = tool_name or "unknown_tool"
        return [
            {
                "type": "agent.tool_result",
                "data": {
                    "tool_name": normalized_tool_name,
                    "name": normalized_tool_name,
                    "ok": True,
                    "success": True,
                    # dapr-agent-py tool_call_end parity: `output` is a STRING
                    # (the tool views render it verbatim; an object shows
                    # "(no output)") + a 500-char `output_preview`.
                    "output": _truncate_output(output_text),
                    "output_preview": output_text[:500] if output_text else "",
                    **_mcp_tool_metadata(normalized_tool_name),
                },
            }
        ]

    if name == "PostToolUseFailure":
        output_text = _flatten_tool_output(payload.get("tool_response"))
        normalized_tool_name = tool_name or "unknown_tool"
        return [
            {
                "type": "agent.tool_result",
                "data": {
                    "tool_name": normalized_tool_name,
                    "name": normalized_tool_name,
                    "ok": False,
                    "success": False,
                    "is_error": True,
                    "output": _truncate_output(output_text),
                    "output_preview": output_text[:500] if output_text else "",
                    "error": _clean(payload.get("error"))
                    or _clean(payload.get("reason"))
                    or "tool failed",
                    **_mcp_tool_metadata(normalized_tool_name),
                },
            }
        ]

    if name in ("PermissionRequest", "PermissionDenied"):
        decision = "ask" if name == "PermissionRequest" else "deny"
        return [
            {
                "type": "hook.decision",
                "data": {"decision": decision, "tool_name": tool_name or "unknown_tool"},
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
        self._completion_keys_raised: set[tuple[str, int]] = set()
        self._completion_fallback_started_turn = False
        self._pending_agy_tool_uses: dict[str, set[str]] = {}
        self._process_lock = asyncio.Lock()

    def _session(self) -> dict[str, Any]:
        supervisor = self._supervisor_getter()
        if supervisor is None:
            return {}
        try:
            return supervisor.get_session() or {}
        except Exception:  # noqa: BLE001
            return {}

    async def process(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, Mapping):
            return {}
        async with self._process_lock:
            return await self._process_locked(payload)

    async def _process_locked(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        name = _hook_name(payload)
        session = self._session()
        session_id = session.get("sessionId")
        instance_id = session.get("instanceId")
        self._record_adapter_hook(payload)

        # EVERY hook payload carries transcript_path — register the tailer
        # opportunistically from any event, never only from SessionStart
        # (observed live: SessionStart did not fire under the early
        # managed-settings matcher shape, so the tailer never started and no
        # agent.message/llm_usage were mirrored).
        self._register_transcript(payload, session_id, instance_id)

        if name == "SessionStart":
            if isinstance(instance_id, str) and instance_id:
                self._completion_keys_raised = {
                    key for key in self._completion_keys_raised if key[0] != instance_id
                }
                self._completion_fallback_started_turn = False
                self._pending_agy_tool_uses.pop(instance_id, None)
            return {}  # registration handled above; no published event

        adapter_turn_done = bool(
            self._adapter is not None and name and self._adapter.is_turn_completion_hook(name)
        )
        stop_hook_completes = True
        if self._adapter is not None and name == "Stop":
            stop_hook_completes = bool(self._adapter.stop_hook_completes_turn())
        should_complete_from_hook = adapter_turn_done or (
            name == "Stop" and stop_hook_completes
        )
        if name == "Stop" or adapter_turn_done:
            response = self._hook_response(name, payload, session)
            if response.get("decision") == "continue":
                if session_id:
                    self._publish(
                        session_id,
                        "hook.decision",
                        {
                            "hook_event": name,
                            "decision": "continue",
                            "reason": response.get("reason"),
                        },
                    )
                return response
            await asyncio.to_thread(self._tailer_manager.flush_now)
            tailer = self._tailer_manager.current()
            last_text = tailer.last_assistant_text if tailer is not None else None
            if not last_text:
                last_text = await self._wait_for_tailer_completion_text()
            if not last_text and self._adapter is not None:
                try:
                    last_text = self._adapter.extract_completion_text(payload)
                except Exception as exc:  # noqa: BLE001
                    logger.debug("[hooks] adapter completion extraction failed: %s", exc)
            if not last_text:
                last_text = _generic_completion_text(payload)
            tailer_published_message = bool(
                tailer is not None
                and getattr(tailer, "assistant_message_published", False)
            )
            if session_id and last_text and not tailer_published_message:
                self._publish(
                    session_id,
                    "agent.message",
                    {"content": [{"type": "text", "text": last_text}]},
                    source_event_id=f"hook-completion:{instance_id or session_id}:{name}",
                    blocking=True,
                )
                if tailer is not None:
                    try:
                        tailer.last_assistant_text = last_text
                        tailer.assistant_message_published = True
                    except Exception:  # noqa: BLE001
                        pass
            already_completed = bool(
                tailer is not None and getattr(tailer, "turn_completion_raised", False)
            )
            turn_count = self._ensure_turn_started_before_completion(session)
            completion_key = (
                (instance_id, turn_count)
                if isinstance(instance_id, str) and instance_id
                else None
            )
            if completion_key is not None and completion_key in self._completion_keys_raised:
                already_completed = True
            if instance_id and should_complete_from_hook and not already_completed:
                event: dict[str, Any] = {"type": "turn.completed"}
                if last_text:
                    event["lastAssistantText"] = last_text
                self._suppress_supervisor_idle_echo()
                await asyncio.to_thread(self._safe_raise, instance_id, [event])
                if completion_key is not None:
                    self._completion_keys_raised.add(completion_key)
            return response

        if name == "SessionEnd":
            await asyncio.to_thread(self._tailer_manager.flush_now)
            if instance_id:
                event = {
                    "type": "cli.session_end",
                    "reason": _clean(payload.get("reason")) or "session_end",
                }
                await asyncio.to_thread(self._safe_raise, instance_id, [event])
            return {}

        if name == "UserPromptSubmit" and self._consume_injected_prompt(payload):
            if self._adapter_reports_prompt_submit():
                if self._completion_fallback_started_turn:
                    self._completion_fallback_started_turn = False
                else:
                    self._record_turn_started("hook:UserPromptSubmit")
            return {}

        events = None
        if self._adapter is not None:
            try:
                events = self._adapter.map_hook_event(payload)
            except Exception as exc:  # noqa: BLE001
                logger.debug("[hooks] adapter mapping failed: %s", exc)
        if events is None:
            events = map_hook_event(payload)
        if name == "UserPromptSubmit" and any(
            event.get("type") == "user.message"
            for event in events
            if isinstance(event, Mapping)
        ):
            if self._completion_fallback_started_turn:
                self._completion_fallback_started_turn = False
            else:
                self._record_turn_started("hook:UserPromptSubmit")
        for event in self._filter_events(session_id, events):
            self._publish(session_id, event["type"], event.get("data") or {})
        response = self._hook_response(name, payload, session)
        for event in self._filter_events(session_id, self._pop_internal_events(response)):
            self._publish(session_id, event["type"], event.get("data") or {})
        return response

    def _hook_response(
        self, name: str | None, payload: Mapping[str, Any], session: Mapping[str, Any]
    ) -> dict[str, Any]:
        if self._adapter is None or not name:
            return {}
        hook_response = getattr(self._adapter, "hook_response", None)
        if not callable(hook_response):
            return {}
        try:
            value = hook_response(name, payload, session)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[hooks] adapter hook response failed: %s", exc)
            return {}
        return dict(value) if isinstance(value, Mapping) else {}

    def _pop_internal_events(self, response: dict[str, Any]) -> list[dict[str, Any]]:
        raw = response.pop("_workflowBuilderEvents", None)
        if not isinstance(raw, list):
            return []
        events: list[dict[str, Any]] = []
        for item in raw:
            if not isinstance(item, Mapping):
                continue
            event_type = item.get("type")
            if not isinstance(event_type, str) or not event_type:
                continue
            events.append({"type": event_type, "data": item.get("data") or {}})
        return events

    def _filter_events(
        self, session_id: Any, events: list[dict[str, Any]] | None
    ) -> list[dict[str, Any]]:
        if not events:
            return []
        if getattr(self._adapter, "name", None) != "antigravity":
            return events
        session_key = str(session_id or "_global")
        filtered: list[dict[str, Any]] = []
        for event in events:
            if not isinstance(event, Mapping):
                continue
            event_type = event.get("type")
            data = event.get("data") or {}
            if not isinstance(data, Mapping):
                data = {}
            if event_type == "agent.tool_use":
                key = self._tool_event_key(data)
                if key:
                    pending = self._pending_agy_tool_uses.setdefault(session_key, set())
                    if key in pending:
                        logger.debug("[hooks] suppressed duplicate agy tool_use %s", key)
                        continue
                    pending.add(key)
            elif event_type == "agent.tool_result":
                self._clear_pending_tool_use(session_key, data)
            filtered.append(dict(event))
        return filtered

    def _tool_event_key(self, data: Mapping[str, Any]) -> str | None:
        tool_name = _clean(data.get("tool_name")) or _clean(data.get("name"))
        if not tool_name:
            return None
        tool_input = data.get("tool_input")
        if not isinstance(tool_input, Mapping):
            tool_input = data.get("input")
        try:
            input_key = json.dumps(tool_input or {}, sort_keys=True, default=str)
        except (TypeError, ValueError):
            input_key = str(tool_input or {})
        return f"{tool_name}:{input_key}"

    def _clear_pending_tool_use(self, session_key: str, data: Mapping[str, Any]) -> None:
        pending = self._pending_agy_tool_uses.get(session_key)
        if not pending:
            return
        key = self._tool_event_key(data)
        if key in pending:
            pending.discard(key)
        else:
            tool_name = _clean(data.get("tool_name")) or _clean(data.get("name"))
            if tool_name:
                prefix = f"{tool_name}:"
                pending.difference_update(
                    candidate for candidate in list(pending) if candidate.startswith(prefix)
                )
        if not pending:
            self._pending_agy_tool_uses.pop(session_key, None)

    async def _wait_for_tailer_completion_text(self) -> str | None:
        wait = getattr(self._tailer_manager, "wait_for_assistant_text", None)
        if not callable(wait) or COMPLETION_TEXT_WAIT_SECONDS <= 0:
            return None
        try:
            value = await wait(
                timeout=COMPLETION_TEXT_WAIT_SECONDS,
                poll_seconds=COMPLETION_TEXT_POLL_SECONDS,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("[hooks] completion text wait failed: %s", exc)
            return None
        return value if isinstance(value, str) and value.strip() else None

    def _record_adapter_hook(self, payload: Mapping[str, Any]) -> None:
        if getattr(self._adapter, "name", None) != "antigravity":
            return
        try:
            from src.agy_stop_guard import record_hook_event

            record_hook_event(payload)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[hooks] adapter hook recording failed: %s", exc)

    def _record_turn_started(self, source: str) -> int | None:
        supervisor = self._supervisor_getter()
        note_turn_started = getattr(supervisor, "note_turn_started", None)
        if not callable(note_turn_started):
            return None
        try:
            value = note_turn_started(source)
            return value if isinstance(value, int) else None
        except Exception as exc:  # noqa: BLE001
            logger.debug("[hooks] turn-start publish failed: %s", exc)
            return None

    def _ensure_turn_started_before_completion(self, session: Mapping[str, Any]) -> int:
        turn_count = _turn_started_count(session)
        live_turn_count = self._supervisor_turn_started_count()
        if live_turn_count > turn_count:
            return live_turn_count
        if turn_count > 0:
            return turn_count
        started = self._record_turn_started("hook:completion-fallback")
        if isinstance(started, int) and started > 0:
            self._completion_fallback_started_turn = True
            return started
        return _turn_started_count(self._session())

    def _supervisor_turn_started_count(self) -> int:
        supervisor = self._supervisor_getter()
        for attr in ("turn_started_count", "_turn_started_count"):
            value = getattr(supervisor, attr, None)
            if isinstance(value, bool):
                continue
            if isinstance(value, int) and value >= 0:
                return value
        return 0

    def _suppress_supervisor_idle_echo(self) -> None:
        supervisor = self._supervisor_getter()
        suppress = getattr(supervisor, "suppress_next_idle_status", None)
        if not callable(suppress):
            return
        try:
            suppress()
        except Exception as exc:  # noqa: BLE001
            logger.debug("[hooks] idle suppression failed: %s", exc)

    def _adapter_reports_prompt_submit(self) -> bool:
        if self._adapter is not None and bool(
            getattr(self._adapter, "hook_reports_prompt_submit", False)
        ):
            return True
        supervisor = self._supervisor_getter()
        return bool(getattr(supervisor, "hook_reports_prompt_submit", False))

    def _consume_injected_prompt(self, payload: Mapping[str, Any]) -> bool:
        prompt = payload.get("prompt")
        if not isinstance(prompt, str) or not prompt:
            return False
        supervisor = self._supervisor_getter()
        consume = getattr(supervisor, "consume_injected_prompt", None)
        if not callable(consume):
            return False
        try:
            if consume(prompt):
                return True
            stripped = prompt.strip()
            return stripped != prompt and bool(stripped) and bool(consume(stripped))
        except Exception as exc:  # noqa: BLE001
            logger.debug("[hooks] injected prompt consume failed: %s", exc)
            return False

    def _register_transcript(
        self, payload: Mapping[str, Any], session_id: Any, instance_id: Any
    ) -> None:
        transcript_path = _clean(payload.get("transcript_path")) or _clean(
            payload.get("transcriptPath")
        )
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
        def _raise_from_tailer(events: list[dict[str, Any]]) -> None:
            if instance_id:
                if any(
                    isinstance(event, Mapping)
                    and event.get("type") == "turn.completed"
                    for event in events
                ):
                    self._suppress_supervisor_idle_echo()
                self._safe_raise(str(instance_id), events)

        self._tailer_manager.start(
            transcript_path,
            session_id,
            publish=self._publish,
            adapter=self._adapter,
            raise_lifecycle=_raise_from_tailer if instance_id else None,
        )
        logger.info("[hooks] transcript tailer started for %s", transcript_path)

    def _safe_raise(self, instance_id: str, events: list[dict[str, Any]]) -> None:
        try:
            self._raise_lifecycle(instance_id, events)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[hooks] raise lifecycle failed for %s: %s", instance_id, exc)


_processors: dict[str, HookProcessor] = {}


def get_processor(adapter_name: str | None = None) -> HookProcessor:
    key = (adapter_name or "claude-code").strip() or "claude-code"
    processor = _processors.get(key)
    if processor is None:
        adapter = None
        if adapter_name:
            try:
                adapter = get_adapter(adapter_name)
            except Exception as exc:  # noqa: BLE001
                logger.debug("[hooks] unknown adapter %s: %s", adapter_name, exc)
        processor = HookProcessor(adapter=adapter)
        _processors[key] = processor
    return processor


def build_router():
    """Build the FastAPI router for CLI hook receivers."""
    router = APIRouter()

    @router.post("/internal/hooks/claude")
    async def claude_hook(request: Request) -> dict[str, Any]:
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            payload = {}
        if isinstance(payload, dict):
            # Respond {} immediately; process out-of-band.
            asyncio.get_running_loop().create_task(
                get_processor("claude-code").process(payload)
            )
        return {}

    @router.post("/internal/hooks/cli/{adapter_name}")
    async def cli_hook(adapter_name: str, request: Request) -> dict[str, Any]:
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            payload = {}
        if isinstance(payload, dict):
            payload.setdefault("hook_adapter", adapter_name)
            return await get_processor(adapter_name).process(payload)
        return {}

    return router
