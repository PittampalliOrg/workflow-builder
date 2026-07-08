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
from src.env_flags import CLI_BACKGROUND_TASK_COUNT_ENABLED, CLI_TURN_FAILED_EDGE_ENABLED
from src.event_publisher import publish_session_event
from src.session_supervisor import get_supervisor
from src.structured_output import (
    STRUCTURED_OUTPUT_MODE_STOP_HOOK,
    STRUCTURED_OUTPUT_MODE_TOOL,
    STRUCTURED_OUTPUT_NUDGE,
    StructuredOutputResult,
    evaluate_structured_output,
    extract_structured_output_from_text,
    is_structured_output_tool,
    max_structured_output_nudges,
    schema_supports_structured_output,
)
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

# New session-event type strings emitted by the CLI hook layer. Kept as
# constants so the adapters reuse them without string drift. These pass through
# the shared event_publisher unchanged (it only remaps a fixed CMA set), so they
# land verbatim in session_events.
SESSION_GOAL_COMPLETED = "session.goal_completed"
SESSION_NOTIFICATION = "session.notification"
SESSION_CONTEXT_COMPACTED = "session.context_compacted"
COMPLETION_TEXT_WAIT_SECONDS = float(
    os.environ.get("CLI_COMPLETION_TEXT_WAIT_SECONDS", "3")
)
COMPLETION_TEXT_POLL_SECONDS = float(
    os.environ.get("CLI_COMPLETION_TEXT_POLL_SECONDS", "0.2")
)
# Stop-hook drain-to-quiescence knobs. On Stop we ALWAYS drain the tailer until
# the transcript has been quiet for STOP_DRAIN_QUIET_SECONDS (capped at
# STOP_DRAIN_MAX_SECONDS) before reading last_assistant_text — otherwise a stale
# mid-turn message present at Stop is captured while the real final line (with
# the verdict) is still being written 0.5–1.3s later.
STOP_DRAIN_MAX_SECONDS = float(os.environ.get("CLI_STOP_DRAIN_MAX_SECONDS", "5"))
STOP_DRAIN_QUIET_SECONDS = float(os.environ.get("CLI_STOP_DRAIN_QUIET_SECONDS", "0.75"))
STOP_DRAIN_POLL_SECONDS = float(os.environ.get("CLI_STOP_DRAIN_POLL_SECONDS", "0.1"))

# CLI_TURN_FAILED_EDGE_ENABLED (turn-FAILURE edge master switch, default ON) is
# imported from the leaf src.env_flags at the top of the module — shared with the
# claude adapter without the hooks_api → cli_adapters import cycle.

# Belt-and-suspenders behind the claude argv `--disallowedTools AskUserQuestion`
# (build_argv, one-shot only): a headless run has no human to answer, so this
# tool call blocks until the pod's activeDeadline kills it (wedging the parent
# workflow). If a CLI version ignores/renames the argv flag, the PreToolUse hook
# still denies the call here.
ASK_USER_QUESTION_TOOL = "AskUserQuestion"
ONE_SHOT_ASK_DENY_REASON = (
    "This is a headless automated run with no human present. Do not ask "
    "questions or wait for input. Write your diagnosis/summary as your final "
    "message and end the turn."
)

# Per-task ``status`` values that mark a background task as DONE. Claude Code's
# Stop-hook payload carries a ``background_tasks`` array; a task is LIVE unless
# its status is one of these. Anything else — including a missing/unknown status
# — is treated as LIVE so the count can never under-report a still-running shell.
_TERMINAL_BACKGROUND_TASK_STATUSES = frozenset(
    {"completed", "failed", "stopped", "killed"}
)


def _count_live_background_tasks(payload: Mapping[str, Any]) -> int | None:
    """Count NON-terminal background tasks reported in a Stop hook payload.

    Returns ``None`` when ``background_tasks`` is absent/None (or not a list) —
    "no data", which a consumer must distinguish from a genuine zero. Otherwise
    returns the number of entries whose ``status`` (lowercased/stripped) is NOT in
    ``_TERMINAL_BACKGROUND_TASK_STATUSES``, treating a missing/unknown status —
    and any non-dict entry — as LIVE. Pure instrumentation; no side effects.
    """
    tasks = payload.get("background_tasks")
    if not isinstance(tasks, list):
        return None
    live = 0
    for task in tasks:
        status = task.get("status") if isinstance(task, Mapping) else None
        normalized = status.strip().lower() if isinstance(status, str) else None
        if normalized not in _TERMINAL_BACKGROUND_TASK_STATUSES:
            live += 1
    return live


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


def _merge_portable_hook_decision(
    response: dict[str, Any],
    event: str,
    decision: str | None,
    reason: str | None,
    contexts: list[str],
) -> dict[str, Any]:
    """Translate an aggregated agentConfig.hooks decision into the response shape
    a CLI honors. Emits BOTH the generic top-level form AND claude's
    `hookSpecificOutput` form so each CLI reads what it understands. Adapter
    responses (e.g. agy stop_guard) already present win — we only ADD."""
    out = dict(response or {})
    if decision == "deny":
        out.setdefault("decision", "block")
        if reason:
            out.setdefault("reason", reason)
        hso = dict(out.get("hookSpecificOutput") or {})
        hso.setdefault("hookEventName", event)
        hso.setdefault("permissionDecision", "deny")
        if reason:
            hso.setdefault("permissionDecisionReason", reason)
        out["hookSpecificOutput"] = hso
    elif decision == "ask":
        hso = dict(out.get("hookSpecificOutput") or {})
        hso.setdefault("hookEventName", event)
        hso.setdefault("permissionDecision", "ask")
        out["hookSpecificOutput"] = hso
    if contexts:
        hso = dict(out.get("hookSpecificOutput") or {})
        hso.setdefault("hookEventName", event)
        existing = hso.get("additionalContext")
        joined = "\n".join([*([existing] if isinstance(existing, str) else []), *contexts])
        hso["additionalContext"] = joined
        out["hookSpecificOutput"] = hso
    return out


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

    # Notification → session.notification (dapr-agent-py parity). Surfaces
    # "agent needs attention / waiting" signals. NOT added to the publisher's
    # notification-hook trigger set, so this can't loop back into a hook.
    if name == "Notification":
        return [
            {
                "type": SESSION_NOTIFICATION,
                "data": {
                    "message": _clean(payload.get("message")),
                    "level": _clean(payload.get("level")),
                    "notificationType": _clean(
                        payload.get("notificationType")
                        or payload.get("notification_type")
                    ),
                },
            }
        ]

    # PreCompact / PostCompact → session.context_compacted{phase} (dapr-agent-py
    # parity for context-window management).
    if name in ("PreCompact", "PostCompact"):
        return [
            {
                "type": SESSION_CONTEXT_COMPACTED,
                "data": {
                    "phase": "pre" if name == "PreCompact" else "post",
                    "trigger": _clean(payload.get("trigger")),
                    "reason": _clean(payload.get("reason")),
                },
            }
        ]

    # SessionStart / Stop / SessionEnd are side-effect-only (handled in
    # _process_locked); anything else is intentionally unmapped.
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
        self._structured_validation_events_seen: set[
            tuple[str, str, bool, str, int | None]
        ] = set()
        self._process_lock = asyncio.Lock()

    def _session(self) -> dict[str, Any]:
        supervisor = self._supervisor_getter()
        if supervisor is None:
            return {}
        try:
            return supervisor.get_session() or {}
        except Exception:  # noqa: BLE001
            return {}

    @staticmethod
    def _session_is_one_shot(session: Mapping[str, Any]) -> bool:
        """True for a headless autoTerminateAfterEndTurn run. Reads the supervisor's
        `oneShot` flag, falling back to a raw autoTerminateAfterEndTurn key."""
        value = session.get("oneShot")
        if isinstance(value, bool):
            return value
        return bool(session.get("autoTerminateAfterEndTurn"))

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
        logger.info(
            "[hooks] recv event=%r adapter=%s session=%s instance=%s",
            name,
            getattr(self._adapter, "name", type(self._adapter).__name__ if self._adapter else None),
            session_id,
            instance_id,
        )

        # Classify the hook up front via the adapter seam (keeps concrete event
        # names like "StopFailure" out of this CLI-agnostic layer): which events
        # are the adapter's authoritative turn-COMPLETION vs turn-FAILURE edges.
        adapter_turn_done = bool(
            self._adapter is not None and name and self._adapter.is_turn_completion_hook(name)
        )
        adapter_turn_failed = bool(
            self._adapter is not None and name and self._adapter.is_turn_failure_hook(name)
        )
        is_turn_terminal = name == "Stop" or adapter_turn_done or adapter_turn_failed

        # SUBAGENT guard — BEFORE any transcript registration. A finishing subagent
        # (Task tool) reports its OWN transcript under ``.../subagents/``; if
        # _register_transcript ran first it would re-point the tailer at that
        # subagent transcript and mirror its content as the PARENT's — the exact
        # thing this guard exists to block. Claude routes subagent completion
        # through the distinct ``SubagentStop`` event, so this is defensive; logged
        # if it ever fires in the wild.
        if is_turn_terminal and self._is_subagent_transcript(payload):
            logger.info(
                "[hooks] ignoring subagent %s (transcript_path=%s) — not a parent turn edge",
                name,
                _clean(payload.get("transcript_path")),
            )
            return {}

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
            return {}  # registration handled above; no published event

        # Turn-FAILURE edge (adapter-declared, e.g. claude StopFailure) → raise
        # ``turn.failed`` on the SAME lifecycle lane as Stop's ``turn.completed``,
        # deduped against the SAME (instance_id, turn_count) key (whichever of the
        # completion/failure edges lands first wins, the other no-ops). Inert when
        # the flag is off.
        if adapter_turn_failed:
            if not CLI_TURN_FAILED_EDGE_ENABLED:
                return {}
            return await self._process_stop_failure(payload, session, instance_id)

        stop_hook_completes = True
        if self._adapter is not None and name == "Stop":
            stop_hook_completes = bool(self._adapter.stop_hook_completes_turn())
        should_complete_from_hook = adapter_turn_done or (
            name == "Stop" and stop_hook_completes
        )
        if name == "Stop" or adapter_turn_done:
            response = await self._hook_response_async(name, payload, session)
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
            # ALWAYS drain the tailer to quiescence first so the FINAL transcript
            # line (published as agent.message + reflected in last_assistant_text)
            # is ingested BEFORE we read it — the Stop hook routinely fires while
            # that line is still being written. Extend the tailer text with the
            # completion-specific adapter/generic fallbacks.
            tailer, last_text = await self._drain_and_resolve_text()
            if not last_text and self._adapter is not None:
                try:
                    last_text = self._adapter.extract_completion_text(payload)
                except Exception as exc:  # noqa: BLE001
                    logger.debug("[hooks] adapter completion extraction failed: %s", exc)
            if not last_text:
                last_text = _generic_completion_text(payload)
            structured_result = self._structured_output_for_completion(
                session,
                last_text,
            )
            if structured_result is not None and not structured_result.valid:
                retry_response = self._structured_retry_response(
                    structured_result,
                    session_id,
                    name,
                )
                if retry_response is not None:
                    return retry_response
            if structured_result is not None and structured_result.valid:
                self._publish_structured_output_validation(session_id, structured_result)
            structured_output = (
                structured_result.value
                if structured_result is not None and structured_result.valid
                else None
            )
            if (
                structured_result is not None
                and structured_result.valid
                and structured_result.canonical_text
            ):
                last_text = structured_result.canonical_text
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
            event: dict[str, Any] = {"type": "turn.completed"}
            if last_text:
                event["lastAssistantText"] = last_text
            if structured_output is not None:
                event["structuredOutput"] = structured_output
                event["structuredOutputText"] = last_text
            # Instrumentation (data only): how many NON-terminal background tasks
            # Claude Code still reports at turn end. Rides ONLY the completion
            # edge — a failed turn's background state is not meaningful. None (no
            # data) is omitted so a real zero stays distinguishable downstream.
            if CLI_BACKGROUND_TASK_COUNT_ENABLED:
                background_task_count = _count_live_background_tasks(payload)
                if background_task_count is not None:
                    event["backgroundTaskCount"] = background_task_count
            # Shared exactly-once turn-edge commit (also used by the failure edge).
            # A transcript-only adapter (should_complete_from_hook False) or an
            # already-raised turn suppresses the raise.
            will_complete, _turn_count, completion_key = await self._raise_turn_edge(
                instance_id=instance_id,
                session=session,
                event=event,
                already_raised=already_completed or not should_complete_from_hook,
            )
            logger.info(
                "[hooks] completion-decision event=%r should_complete=%s "
                "already=%s key=%s -> raising=%s",
                name,
                should_complete_from_hook,
                already_completed,
                completion_key,
                will_complete,
            )
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

        # Belt-and-suspenders human-input guard: in a headless one-shot run, deny
        # AskUserQuestion at the PreToolUse hook (covers CLI versions that ignore
        # or rename the argv --disallowedTools flag). PreToolUse is a blocking
        # event, so this deny response reaches the CLI and stops the tool call.
        if (
            name == "PreToolUse"
            and _clean(payload.get("tool_name")) == ASK_USER_QUESTION_TOOL
            and self._session_is_one_shot(session)
        ):
            if session_id:
                self._publish(
                    session_id,
                    "hook.decision",
                    {
                        "hook_event": name,
                        "decision": "deny",
                        "reason": ONE_SHOT_ASK_DENY_REASON,
                        "tool_name": ASK_USER_QUESTION_TOOL,
                        "source": "one-shot-ask-guard",
                    },
                )
            return _merge_portable_hook_decision(
                {}, name, "deny", ONE_SHOT_ASK_DENY_REASON, []
            )

        if name in {"PreToolUse", "PostToolUse"}:
            self._capture_structured_output_tool_call(payload, session, session_id)
            session = self._session()

        if name == "UserPromptSubmit":
            # Deterministic submit ack: the hook firing proves the CLI accepted a
            # typed prompt. The supervisor's inject loop waits on this instead of
            # guessing readiness from screen/status. Fire before the dedup branch so
            # it counts for both hook-authoritative (codex) and marker (claude) CLIs.
            self._note_prompt_submit_ack()

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
        for event in events:
            event_type = event["type"]
            event_data = event.get("data") or {}
            if isinstance(event_data, Mapping):
                if self._capture_structured_output_event(
                    event_type, event_data, session, session_id
                ):
                    session = self._session()
            self._publish(session_id, event_type, event_data)
        response = await self._hook_response_async(name, payload, session)
        # P3: portable agentConfig.hooks — execute the run's user-declared command
        # hooks for this event and fold their decision into the response the CLI
        # honors (claude PreToolUse blocks via the HTTP response; codex/agy are
        # advisory). command-only; callbacks are dapr-agent-py-only.
        response = await self._apply_portable_hooks(name, payload, session_id, response)
        for event in self._pop_internal_events(response):
            event_type = event["type"]
            event_data = event.get("data") or {}
            if isinstance(event_data, Mapping):
                if self._capture_structured_output_event(
                    event_type, event_data, session, session_id
                ):
                    session = self._session()
            self._publish(session_id, event_type, event_data)
        return response

    async def _apply_portable_hooks(
        self,
        name: str | None,
        payload: Mapping[str, Any],
        session_id: Any,
        response: dict[str, Any],
    ) -> dict[str, Any]:
        if not name:
            return response
        try:
            from src.hook_exec import has_run_hooks, run_event_hooks
        except Exception:  # noqa: BLE001
            return response
        if not has_run_hooks():
            return response
        try:
            tool_name = _clean(payload.get("tool_name")) or _clean(payload.get("toolName"))
            agg = await run_event_hooks(name, tool_name=tool_name, hook_input=dict(payload))
        except Exception as exc:  # noqa: BLE001
            logger.warning("[hooks] portable hook exec failed for %s: %s", name, exc)
            return response
        if not agg.get("matched"):
            return response
        decision = agg.get("decision")
        reason = agg.get("reason")
        contexts = agg.get("contexts") or []
        if session_id:
            self._publish(
                session_id,
                "hook.decision",
                {
                    "hook_event": name,
                    "decision": decision or "allow",
                    "reason": reason,
                    "source": "agentConfig.hooks",
                },
            )
        return _merge_portable_hook_decision(response, name, decision, reason, contexts)

    async def _hook_response_async(
        self, name: str | None, payload: Mapping[str, Any], session: Mapping[str, Any]
    ) -> dict[str, Any]:
        # Some adapters synchronously execute managed tool shims while computing
        # a hook response. Keep that work off the ASGI event loop so health and
        # readiness probes keep responding during long-running commands.
        return await asyncio.to_thread(self._hook_response, name, payload, session)

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

    def _structured_schema(self, session: Mapping[str, Any]) -> dict[str, Any] | None:
        if not self._session_is_one_shot(session):
            return None
        agent_config = session.get("agentConfig")
        if not isinstance(agent_config, Mapping):
            return None
        mode = agent_config.get("structuredOutputMode")
        if mode not in {STRUCTURED_OUTPUT_MODE_STOP_HOOK, STRUCTURED_OUTPUT_MODE_TOOL}:
            return None
        schema = agent_config.get("responseJsonSchema")
        if not schema_supports_structured_output(schema):
            return None
        return dict(schema)

    def _record_structured_output_result(self, result: StructuredOutputResult) -> None:
        if not result.valid or result.value is None or not result.canonical_text:
            return
        supervisor = self._supervisor_getter()
        record = getattr(supervisor, "record_structured_output", None)
        if callable(record):
            try:
                record(result.value, result.canonical_text)
            except Exception as exc:  # noqa: BLE001
                logger.debug("[hooks] structured output record failed: %s", exc)

    def _publish_structured_output_validation(
        self,
        session_id: Any,
        result: StructuredOutputResult,
        *,
        attempts: int | None = None,
    ) -> None:
        if not session_id:
            return
        payload_key = result.canonical_text or result.feedback or ""
        key = (
            str(session_id),
            result.source or "",
            bool(result.valid),
            payload_key,
            attempts,
        )
        if key in self._structured_validation_events_seen:
            return
        self._structured_validation_events_seen.add(key)
        data: dict[str, Any] = {
            "ok": result.valid,
            "source": result.source,
        }
        if result.feedback:
            data["feedback"] = result.feedback
        if attempts is not None:
            data["attempts"] = attempts
        self._publish(session_id, "structured_output.validation", data)

    def _capture_structured_output_tool_call(
        self,
        payload: Mapping[str, Any],
        session: Mapping[str, Any],
        session_id: Any,
    ) -> None:
        tool_name = _clean(payload.get("tool_name")) or _clean(payload.get("toolName"))
        if not is_structured_output_tool(tool_name):
            return
        schema = self._structured_schema(session)
        if schema is None:
            return
        value = self._structured_output_value_from_tool_input(payload)
        if not isinstance(value, Mapping):
            value = self._structured_output_value_from_tool_response(payload)
        result = evaluate_structured_output(
            schema,
            value,
            source="tool_call",
        )
        if result.valid:
            self._record_structured_output_result(result)
        self._publish_structured_output_validation(session_id, result)

    def _capture_structured_output_event(
        self,
        event_type: str,
        data: Mapping[str, Any],
        session: Mapping[str, Any],
        session_id: Any,
    ) -> bool:
        if event_type not in {"agent.tool_use", "agent.tool_result"}:
            return False
        payload = dict(data)
        if event_type == "agent.tool_result":
            if payload.get("ok") is False or payload.get("success") is False:
                return False
            if "tool_response" not in payload:
                output = payload.get("output")
                if output is None:
                    output = payload.get("output_preview")
                if output is not None:
                    payload["tool_response"] = output
        before = dict(session)
        self._capture_structured_output_tool_call(payload, session, session_id)
        after = self._session()
        return (
            before.get("structuredOutput") != after.get("structuredOutput")
            or before.get("structuredOutputText") != after.get("structuredOutputText")
        )

    @staticmethod
    def _structured_output_value_from_tool_input(
        payload: Mapping[str, Any],
    ) -> Mapping[str, Any] | None:
        for key in ("tool_input", "input"):
            value = payload.get(key)
            if not isinstance(value, Mapping):
                continue
            is_mcp_wrapper = any(
                marker in value
                for marker in (
                    "ServerName",
                    "serverName",
                    "server_name",
                    "server",
                    "ToolName",
                    "toolName",
                    "tool_name",
                )
            )
            if is_mcp_wrapper:
                for nested_key in (
                    "arguments",
                    "Arguments",
                    "tool_arguments",
                    "toolArguments",
                    "ToolArguments",
                ):
                    nested = value.get(nested_key)
                    if isinstance(nested, Mapping):
                        return nested
            return value
        return None

    @staticmethod
    def _structured_output_value_from_tool_response(
        payload: Mapping[str, Any],
    ) -> dict[str, Any] | None:
        output = _flatten_tool_output(payload.get("tool_response"))
        if not output:
            return None
        try:
            parsed = json.loads(output)
        except (TypeError, ValueError):
            return None
        return dict(parsed) if isinstance(parsed, Mapping) else None

    def _structured_output_for_completion(
        self,
        session: Mapping[str, Any],
        last_text: str | None,
    ) -> StructuredOutputResult | None:
        schema = self._structured_schema(session)
        if schema is None:
            return None
        existing = session.get("structuredOutput")
        existing_text = session.get("structuredOutputText")
        if isinstance(existing, Mapping) and isinstance(existing_text, str) and existing_text:
            return StructuredOutputResult(
                valid=True,
                value=dict(existing),
                canonical_text=existing_text,
                source="tool_call",
            )
        result = extract_structured_output_from_text(schema, last_text)
        if result.valid:
            self._record_structured_output_result(result)
        return result

    def _structured_retry_response(
        self,
        result: StructuredOutputResult,
        session_id: Any,
        hook_name: str | None,
    ) -> dict[str, Any] | None:
        supervisor = self._supervisor_getter()
        attempts = 1
        note_retry = getattr(supervisor, "note_structured_output_retry", None)
        if callable(note_retry):
            try:
                attempts = int(note_retry(result.feedback or "invalid structured output"))
            except Exception as exc:  # noqa: BLE001
                logger.debug("[hooks] structured output retry note failed: %s", exc)
        self._publish_structured_output_validation(session_id, result, attempts=attempts)
        if attempts > max_structured_output_nudges():
            return None
        reason = "Structured output validation failed."
        if result.feedback:
            reason = f"{reason}\n{result.feedback}"
        reason = f"{reason}\n\n{STRUCTURED_OUTPUT_NUDGE}"
        if session_id:
            self._publish(
                session_id,
                "hook.decision",
                {
                    "hook_event": hook_name,
                    "decision": "continue",
                    "reason": reason,
                    "source": "structured-output-stop-hook",
                },
            )
        return {"decision": "continue", "reason": reason}

    async def _drain_tailer_to_quiescence(self) -> None:
        """Drain the tailer until the transcript stops growing (Stop-hook race
        fix). Falls back to a single flush for tailer managers that predate the
        drain capability."""
        drain = getattr(self._tailer_manager, "drain_quiescent", None)
        if callable(drain):
            try:
                await drain(
                    max_wait=STOP_DRAIN_MAX_SECONDS,
                    quiet_period=STOP_DRAIN_QUIET_SECONDS,
                    poll_seconds=STOP_DRAIN_POLL_SECONDS,
                )
                return
            except Exception as exc:  # noqa: BLE001
                logger.debug("[hooks] tailer drain failed: %s", exc)
        await asyncio.to_thread(self._tailer_manager.flush_now)

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

    def _note_prompt_submit_ack(self) -> None:
        supervisor = self._supervisor_getter()
        fn = getattr(supervisor, "note_prompt_submit_ack", None)
        if callable(fn):
            try:
                fn()
            except Exception:  # noqa: BLE001
                pass

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
        if turn_count > 0:
            return turn_count
        started = self._record_turn_started("hook:completion-fallback")
        if isinstance(started, int) and started > 0:
            self._completion_fallback_started_turn = True
            return started
        return _turn_started_count(self._session())

    @staticmethod
    def _is_subagent_transcript(payload: Mapping[str, Any]) -> bool:
        """True when the hook's transcript belongs to a subagent (Task tool) run —
        claude writes those under a ``subagents/`` directory. A subagent turn edge
        must not be treated as the parent turn's completion/failure."""
        path = _clean(payload.get("transcript_path")) or _clean(
            payload.get("transcriptPath")
        )
        return bool(path and "/subagents/" in path)

    async def _drain_and_resolve_text(self) -> tuple[Any, str | None]:
        """Drain the tailer to quiescence and resolve the current assistant text
        from it — shared by the Stop (turn.completed) and StopFailure (turn.failed)
        edges. Returns ``(tailer, last_text)``; the Stop path extends ``last_text``
        with its own adapter/generic fallbacks."""
        await self._drain_tailer_to_quiescence()
        tailer = self._tailer_manager.current()
        last_text = tailer.last_assistant_text if tailer is not None else None
        if not last_text:
            last_text = await self._wait_for_tailer_completion_text()
        return tailer, last_text

    async def _raise_turn_edge(
        self,
        *,
        instance_id: Any,
        session: Mapping[str, Any],
        event: dict[str, Any],
        already_raised: bool,
    ) -> tuple[bool, int, tuple[Any, int] | None]:
        """Exactly-once turn-edge raise shared by the Stop (turn.completed) and
        StopFailure (turn.failed) branches: resolve the turn count, enforce the
        ``(instance_id, turn_count)`` dedup key, and — unless this turn already
        produced an edge — suppress the supervisor idle echo and raise ``event``
        onto the lifecycle lane. Returns ``(raised, turn_count, completion_key)``."""
        turn_count = self._ensure_turn_started_before_completion(session)
        completion_key = (
            (instance_id, turn_count)
            if isinstance(instance_id, str) and instance_id
            else None
        )
        already = already_raised or (
            completion_key is not None and completion_key in self._completion_keys_raised
        )
        will_raise = bool(instance_id and not already)
        if will_raise:
            self._suppress_supervisor_idle_echo()
            await asyncio.to_thread(self._safe_raise, instance_id, [event])
            if completion_key is not None:
                self._completion_keys_raised.add(completion_key)
        return will_raise, turn_count, completion_key

    async def _process_stop_failure(
        self,
        payload: Mapping[str, Any],
        session: Mapping[str, Any],
        instance_id: Any,
    ) -> dict[str, Any]:
        """Raise a ``turn.failed`` lifecycle edge from an adapter-declared failure
        hook (claude StopFailure).

        Shares the Stop edge's drain + exactly-once protocol via
        ``_drain_and_resolve_text`` + ``_raise_turn_edge``, so a Stop and a
        StopFailure for the SAME turn dedup against ONE ``(instance_id,
        turn_count)`` completion key — whichever lands first wins, the other
        no-ops. Error text comes from the payload (``error``/``reason``/
        ``message``) falling back to the last tailer line; unlike Stop it does not
        publish a partial ``agent.message`` (the error carries the signal)."""
        tailer, last_text = await self._drain_and_resolve_text()
        error_text = (
            _clean(payload.get("error"))
            or _clean(payload.get("reason"))
            or _clean(payload.get("message"))
            or last_text
            or "the turn failed"
        )
        # A turn already completed (native transcript OR a prior Stop/StopFailure
        # for this turn) means this failure edge is a duplicate → no-op.
        already_done = bool(
            tailer is not None and getattr(tailer, "turn_completion_raised", False)
        )
        event: dict[str, Any] = {"type": "turn.failed", "error": error_text}
        if last_text:
            event["lastAssistantText"] = last_text
        will_fail, _turn_count, completion_key = await self._raise_turn_edge(
            instance_id=instance_id,
            session=session,
            event=event,
            already_raised=already_done,
        )
        logger.info(
            "[hooks] failure-decision event=StopFailure already=%s key=%s -> raising=%s",
            already_done,
            completion_key,
            will_fail,
        )
        return {}

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
        # Fallback: some CLIs (Antigravity) don't carry transcript_path in their
        # command-hook payloads, so a transient early-hook miss would leave the
        # tailer unregistered and nothing mirrored (no agent.message/llm_usage).
        # Let the adapter discover its own transcript file from ANY hook; the
        # tailer reads from offset 0 so a late registration backfills losslessly.
        if not transcript_path and self._adapter is not None:
            try:
                transcript_path = _clean(self._adapter.discover_transcript_path())
            except Exception:  # noqa: BLE001
                transcript_path = None
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

        def _observe_from_tailer(event_type: str, data: Mapping[str, Any]) -> None:
            session = self._session()
            self._capture_structured_output_event(
                event_type,
                data,
                session,
                session.get("sessionId") or session_id,
            )

        self._tailer_manager.start(
            transcript_path,
            session_id,
            publish=self._publish,
            adapter=self._adapter,
            raise_lifecycle=_raise_from_tailer if instance_id else None,
            event_observer=_observe_from_tailer,
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

    # Events where the hook RESPONSE can gate the tool/turn — these must be
    # processed synchronously so a portable agentConfig.hooks deny/ask actually
    # reaches Claude Code (P3 blocking). All other events stay fire-and-forget so
    # turn-completion timing is unaffected.
    _CLAUDE_BLOCKING_EVENTS = {"PreToolUse", "PermissionRequest"}

    @router.post("/internal/hooks/claude")
    async def claude_hook(request: Request) -> dict[str, Any]:
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            payload = {}
        if not isinstance(payload, dict):
            return {}
        event = _hook_name(payload)
        if event in _CLAUDE_BLOCKING_EVENTS:
            # Await + return the decision so a deny/ask blocks the tool.
            return await get_processor("claude-code").process(payload)
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
