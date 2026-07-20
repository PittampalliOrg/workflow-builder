"""BrowserUseExecutor — a dapr-agents ``AgentExecutorBase`` driving browser-use.

The executor owns one agent turn: it attaches to the remote chromium over CDP
(``BROWSER_USE_CDP_URL``; the browser is a sidecar, never in-process), drives
``browser_use.Agent`` step-by-step via the public ``take_step()`` API, and
yields the typed ``AgentEvent`` stream that ``DurableAgent``'s ``run_executor``
activity consumes (message → tool_call/tool_result per browser action →
session checkpoint → complete/error).

Durability model (P1): the whole turn runs inside one ``run_executor``
activity. ``AgentState`` snapshots are kept in-memory keyed by executor
session-id so a same-pod activity retry resumes forward progress
(``injected_agent_state``) instead of restarting the task; the live browser
state (cookies, tabs) survives retries in the remote chromium regardless.
Cross-pod state persistence is the per-step-activity phase (P2).

Cancellation: the Lifecycle Controller's raise-event path persists a
``session-cancel:{instance}`` key before raising the external event. The
workflow can't poll mid-activity on the executor path, so we check that key
between steps — same key + turn-suffix-stripping semantics as dapr-agent-py.
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.parse
import urllib.request
from typing import Any, AsyncGenerator, Callable, Dict, Optional
from uuid import uuid4

from dapr_agents.agents.executors.base import AgentExecutorBase
from dapr_agents.agents.executors.event import AgentEvent

from src.config import (
    AGENT_STATE_STORE,
    BROWSER_CDP_URL,
    CALCULATE_COST,
    DEFAULT_MAX_STEPS,
    MAX_ACTIONS_PER_STEP,
    MAX_FAILURES,
    MAX_HISTORY_ITEMS,
    TOOL_RESULT_MAX_CHARS,
    USE_VISION,
)
from src.event_publisher import publish_session_event
from src.kimi_llm import build_chat_model, resolve_kimi_model
from src.session_native import terminal_stop_reason_from_events

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Cancellation plumbing (ported from services/dapr-agent-py/src/main.py)
# ---------------------------------------------------------------------------


def _session_cancel_state_key(instance_id: str) -> str:
    return f"session-cancel:{instance_id}"


def _cancellation_candidate_ids(instance_id: str) -> list[str]:
    """Cancellation-flag lookup keys for a durable instance id.

    The raise-event endpoint writes ``session-cancel:{session_instance}``, but
    in auto-terminate (durable/run) mode the inner ``agent_workflow`` runs
    under a turn-scoped id ``<session>__turn__N`` (and some payloads use
    ``<session>:turn-N``). Check the exact key first, then the base id.
    """
    text = str(instance_id or "").strip()
    if not text:
        return []
    ids = [text]
    base = re.sub(r"__turn__\d+$", "", text)
    base = re.sub(r":turn-\d+$", "", base)
    if base and base != text and base not in ids:
        ids.append(base)
    return ids


def _read_agent_state_key(key: str) -> Any | None:
    sidecar = (
        f"http://{os.environ.get('DAPR_HOST', '127.0.0.1')}:"
        f"{os.environ.get('DAPR_HTTP_PORT', '3500')}"
    )
    encoded_key = urllib.parse.quote(key, safe="")
    url = (
        f"{sidecar}/v1.0/state/{AGENT_STATE_STORE}/{encoded_key}"
        f"?metadata.partitionKey={encoded_key}"
    )
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, method="GET"), timeout=5
        ) as response:
            body = response.read()
    except Exception:  # noqa: BLE001 — missing key / sidecar blip → not cancelled
        return None
    if not body:
        return None
    try:
        return json.loads(body)
    except (TypeError, ValueError):
        return None


def read_cancellation_request(scope_id: str) -> dict[str, Any] | None:
    for candidate in _cancellation_candidate_ids(scope_id):
        value = _read_agent_state_key(_session_cancel_state_key(candidate))
        if isinstance(value, dict) and value.get("type"):
            return value
    return None


def _cancelled_result(cancel_request: dict[str, Any]) -> dict[str, Any]:
    stop_reason = terminal_stop_reason_from_events([cancel_request]) or {
        "type": "terminated"
    }
    reason = str(
        cancel_request.get("reason")
        or stop_reason.get("reason")
        or "session cancelled"
    )
    return {
        "role": "assistant",
        "content": reason,
        "success": False,
        "cancelled": True,
        "error": reason,
        "stop_reason": stop_reason,
    }


# ---------------------------------------------------------------------------
# browser-use agent construction
# ---------------------------------------------------------------------------


def _default_agent_factory(
    *,
    task: str,
    agent_config: dict[str, Any],
    injected_state: Any | None,
):
    """Build a ``browser_use.Agent`` attached to the remote CDP browser.

    Import is lazy so unit tests can inject a fake factory without the
    browser-use package (and so a broken chromium never blocks module import).
    """
    from browser_use import Agent as BrowserUseAgent
    from browser_use import Browser

    browser = Browser(cdp_url=BROWSER_CDP_URL, is_local=False)
    kwargs: dict[str, Any] = {
        "task": task,
        "llm": build_chat_model(agent_config),
        "browser": browser,
        "use_vision": USE_VISION,
        "max_actions_per_step": MAX_ACTIONS_PER_STEP,
        "max_history_items": MAX_HISTORY_ITEMS,
        "max_failures": MAX_FAILURES,
        "calculate_cost": CALCULATE_COST,
        "enable_signal_handler": False,  # we run on workflow worker threads
        "source": "workflow-builder/browser-use-agent",
    }
    system_prompt = str(agent_config.get("systemPrompt") or "").strip()
    if system_prompt:
        # Extend, never override — browser-use's core prompt carries the
        # action-format contract the structured output depends on.
        kwargs["extend_system_message"] = system_prompt
    if injected_state is not None:
        kwargs["injected_agent_state"] = injected_state
    return BrowserUseAgent(**kwargs)


def _resolve_max_steps(agent_config: dict[str, Any]) -> int:
    for key in ("maxTurns", "maxIterations"):
        raw = agent_config.get(key)
        try:
            value = int(raw)
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    return DEFAULT_MAX_STEPS


def _truncate(text: str, limit: int = TOOL_RESULT_MAX_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"… [truncated {len(text) - limit} chars]"


def _serialize_action(action: Any) -> tuple[str, dict[str, Any]]:
    """Dump a browser-use ActionModel to (name, params)."""
    try:
        dumped = action.model_dump(exclude_unset=True, exclude_none=True)
    except Exception:  # noqa: BLE001
        return str(type(action).__name__), {}
    for name, params in dumped.items():
        if params is not None:
            return str(name), params if isinstance(params, dict) else {"value": params}
    return "unknown_action", {}


def _result_payload(result: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for attr in ("extracted_content", "error", "is_done", "success", "long_term_memory"):
        value = getattr(result, attr, None)
        if value is None:
            continue
        if isinstance(value, str):
            value = _truncate(value)
        payload[attr] = value
    return payload


def _assistant_text(model_output: Any) -> str:
    parts: list[str] = []
    for attr in ("evaluation_previous_goal", "next_goal"):
        value = getattr(model_output, attr, None)
        if value:
            parts.append(str(value))
    return "\n".join(parts).strip()


class BrowserUseExecutor(AgentExecutorBase):
    """Drives ``browser_use.Agent`` as a dapr-agents executor."""

    def __init__(
        self,
        *,
        agent_factory: Optional[Callable[..., Any]] = None,
        cancellation_reader: Optional[Callable[[str], dict[str, Any] | None]] = None,
    ) -> None:
        self._agent_factory = agent_factory or _default_agent_factory
        self._read_cancellation = cancellation_reader or read_cancellation_request
        # sid -> latest AgentState; same-pod retry resume (see module docstring).
        self._states: Dict[str, Any] = {}

    async def run(
        self,
        prompt: str,
        *,
        session_id: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
    ) -> AsyncGenerator[AgentEvent, None]:
        ctx = dict(context or {})
        sid = session_id or f"buse-{uuid4().hex[:12]}"
        cma_session_id = str(ctx.get("sessionId") or "") or None
        agent_cfg = (
            ctx.get("agentConfig") if isinstance(ctx.get("agentConfig"), dict) else {}
        )
        turn = int(ctx.get("turn") or 1)
        turn_id = str(ctx.get("turnId") or f"{sid}:turn-{turn}")
        cancel_scope = str(ctx.get("cancellationScopeId") or "")
        # Deterministic per-turn prefix → CMA ingest dedup on activity retry.
        event_scope = cancel_scope or sid
        max_steps = _resolve_max_steps(agent_cfg)

        try:
            agent = self._agent_factory(
                task=prompt,
                agent_config=agent_cfg,
                injected_state=self._states.get(sid),
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("[executor] browser-use agent construction failed")
            yield AgentEvent(
                type="error",
                content=f"browser-use agent construction failed: {exc}",
                session_id=sid,
            )
            return

        completed_via_done = False
        steps_taken = 0
        try:
            from browser_use.agent.views import AgentStepInfo

            # Agent.run() starts the browser session before stepping; external
            # take_step() driving must do the same or every action fails with
            # "CDP client not initialized" (verified live).
            browser_session = getattr(agent, "browser_session", None)
            if browser_session is not None:
                await browser_session.start()

            for step_no in range(1, max_steps + 1):
                if cancel_scope:
                    cancel = self._read_cancellation(cancel_scope)
                    if cancel:
                        logger.info(
                            "[executor] cancellation observed for %s at step %d",
                            cancel_scope,
                            step_no,
                        )
                        yield AgentEvent(
                            type="complete",
                            content=_cancelled_result(cancel),
                            session_id=sid,
                        )
                        return

                prev_len = len(agent.history.history)
                # Mirror Agent.run()'s numbering: 0-indexed step_number.
                step_info = AgentStepInfo(
                    step_number=max(int(getattr(agent.state, "n_steps", step_no)) - 1, 0),
                    max_steps=max_steps,
                )
                is_done, is_valid = await agent.take_step(step_info)
                steps_taken = step_no

                for item in agent.history.history[prev_len:]:
                    for event in self._events_from_history_item(
                        item,
                        sid=sid,
                        cma_session_id=cma_session_id,
                        event_scope=event_scope,
                        turn=turn,
                        turn_id=turn_id,
                        step_no=step_no,
                    ):
                        yield event

                self._states[sid] = agent.state
                yield AgentEvent(
                    type="session",
                    content={"step": step_no, "n_steps": getattr(agent.state, "n_steps", None)},
                    session_id=sid,
                )

                if is_done:
                    completed_via_done = True
                    break

            self._publish_usage(
                agent,
                cma_session_id=cma_session_id,
                agent_cfg=agent_cfg,
                event_scope=event_scope,
                turn=turn,
                turn_id=turn_id,
            )

            final_text = None
            try:
                final_text = agent.history.final_result()
            except Exception:  # noqa: BLE001
                pass
            success: Any = None
            try:
                success = agent.history.is_successful()
            except Exception:  # noqa: BLE001
                pass
            if not final_text:
                final_text = (
                    "Browser task ended without an explicit result."
                    if completed_via_done
                    else f"Browser task stopped after reaching the {max_steps}-step budget."
                )
            yield AgentEvent(
                type="complete",
                content={
                    "role": "assistant",
                    "content": _truncate(str(final_text), TOOL_RESULT_MAX_CHARS * 4),
                    "success": bool(success) if success is not None else completed_via_done,
                    "is_done": completed_via_done,
                    "steps": steps_taken,
                },
                session_id=sid,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("[executor] browser-use run failed")
            yield AgentEvent(
                type="error",
                content=f"{type(exc).__name__}: {exc}",
                session_id=sid,
            )
        finally:
            try:
                state = getattr(agent, "state", None)
                if state is not None:
                    self._states[sid] = state
            except Exception:  # noqa: BLE001
                pass
            # Agent.run()'s finally stops the agent-level bubus event bus
            # before close(); external take_step() driving must do the same or
            # bus tasks keep the activity's asyncio.run() loop alive forever
            # (verified live: run_executor never returned after a successful
            # 'done'). Bound the whole teardown so a wedged CDP/bus can never
            # hang the durable activity.
            try:
                import asyncio

                async def _teardown() -> None:
                    eventbus = getattr(agent, "eventbus", None)
                    if eventbus is not None:
                        try:
                            await eventbus.stop(clear=True, timeout=3.0)
                        except Exception as exc:  # noqa: BLE001
                            logger.warning(
                                "[executor] eventbus stop failed: %s", exc
                            )
                    # Disconnects from the remote CDP browser; the chromium
                    # sidecar itself stays up (is_local=False — we never own
                    # the browser).
                    await agent.close()

                await asyncio.wait_for(_teardown(), timeout=15.0)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[executor] browser-use agent teardown failed: %s", exc)

    async def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        state = self._states.get(session_id)
        if state is None:
            return None
        try:
            snapshot = state.model_dump(mode="json")
        except Exception:  # noqa: BLE001
            snapshot = None
        return {"state": snapshot, "metadata": {"backend": "in-memory"}}

    # ------------------------------------------------------------------
    # Event mapping
    # ------------------------------------------------------------------

    def _events_from_history_item(
        self,
        item: Any,
        *,
        sid: str,
        cma_session_id: str | None,
        event_scope: str,
        turn: int,
        turn_id: str,
        step_no: int,
    ) -> list[AgentEvent]:
        events: list[AgentEvent] = []
        model_output = getattr(item, "model_output", None)
        results = list(getattr(item, "result", None) or [])

        if model_output is not None:
            text = _assistant_text(model_output)
            if text:
                events.append(
                    AgentEvent(
                        type="message",
                        content={"role": "assistant", "content": text},
                        session_id=sid,
                    )
                )
                publish_session_event(
                    cma_session_id,
                    "llm_complete",
                    {"content": text, "turn": turn, "step": step_no},
                    source_event_id=f"{event_scope}:{turn_id}:s{step_no}:msg",
                    instance_id=event_scope,
                )

        actions = list(getattr(model_output, "action", None) or [])
        for index, action in enumerate(actions):
            name, params = _serialize_action(action)
            tc_id = f"{turn_id}:s{step_no}:a{index}"
            events.append(
                AgentEvent(
                    type="tool_call",
                    content={"id": tc_id, "name": name, "arguments": params},
                    session_id=sid,
                )
            )
            publish_session_event(
                cma_session_id,
                "tool_call_start",
                {"toolName": name, "args": params, "tool_use_id": tc_id},
                source_event_id=f"{event_scope}:{tc_id}:start",
                instance_id=event_scope,
            )
            if index >= len(results):
                continue
            payload = _result_payload(results[index])
            events.append(
                AgentEvent(
                    type="tool_result",
                    content={"tool_call_id": tc_id, "result": payload, "name": name},
                    session_id=sid,
                )
            )
            error = payload.get("error")
            publish_session_event(
                cma_session_id,
                "tool_call_error" if error else "tool_call_end",
                {
                    "toolName": name,
                    "tool_use_id": tc_id,
                    "output": payload,
                    **({"error": error} if error else {}),
                },
                source_event_id=f"{event_scope}:{tc_id}:end",
                instance_id=event_scope,
            )
        return events

    def _publish_usage(
        self,
        agent: Any,
        *,
        cma_session_id: str | None,
        agent_cfg: dict[str, Any],
        event_scope: str,
        turn: int,
        turn_id: str,
    ) -> None:
        """Best-effort per-turn agent.llm_usage (net of cache reads —
        platform budget invariant)."""
        try:
            usage = getattr(getattr(agent, "history", None), "usage", None)
            if usage is None:
                return
            prompt = int(getattr(usage, "total_prompt_tokens", 0) or 0)
            cached = int(getattr(usage, "total_prompt_cached_tokens", 0) or 0)
            completion = int(getattr(usage, "total_completion_tokens", 0) or 0)
            if prompt <= 0 and completion <= 0:
                return
            publish_session_event(
                cma_session_id,
                "agent.llm_usage",
                {
                    "input_tokens": max(prompt - cached, 0),
                    "output_tokens": completion,
                    "cache_read_input_tokens": cached,
                    "model": resolve_kimi_model(agent_cfg),
                    "turn": turn,
                },
                source_event_id=f"{event_scope}:{turn_id}:usage",
                instance_id=event_scope,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("[executor] usage publish skipped: %s", exc)
