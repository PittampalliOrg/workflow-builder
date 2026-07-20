"""BrowserUseDurableAgent — DurableAgent wired to the browser-use executor.

The inner loop is delegated to ``BrowserUseExecutor`` via dapr-agents' native
executor seam (stock ``agent_workflow`` → ``run_executor`` activity). This
subclass adds the one thing the platform dispatch contract requires that the
framework does not ship: the ``session_workflow`` wrapper the orchestrator's
``durable/run`` bridge (and the BFF spawn path) schedules by literal name.

This is a deliberately minimal port of dapr-agent-py's session_workflow —
same input shape, same ``session.status_*`` event vocabulary, same
``autoTerminateAfterEndTurn`` one-shot semantics, same terminal-control-event
handling without the OpenShell/instruction-bundle/compaction layers
that don't apply to a browser agent (those arrive with later phases if
needed).
"""

from __future__ import annotations

import json
import logging
from typing import Any

from dapr_agents.agents.durable import DurableAgent
from dapr_agents.workflow.decorators import workflow_entry

from src.event_publisher import publish_session_event
from src.session_config import apply_session_control_events
from src.session_native import (
    logical_turn_id,
    session_native_event_fields,
    session_workflow_instance_id,
    session_workflow_state_from_message,
    terminal_stop_reason_from_events,
)

logger = logging.getLogger(__name__)


def _coerce_agent_config(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return {}
        if isinstance(parsed, dict):
            return parsed
    return {}


def _compose_turn_task(events: list[dict]) -> str:
    """Collapse a batch of user events into a single task string.

    Same shape as dapr-agent-py: ``user.message`` text blocks concatenate;
    other event types append as bracketed notes.
    """
    parts: list[str] = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        et = ev.get("type") or ""
        if et == "user.message":
            content = ev.get("content") or ev.get("data", {}).get("content") or []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text = str(block.get("text") or "")
                    if text:
                        parts.append(text)
        elif et == "user.tool_confirmation":
            result = ev.get("result") or ev.get("data", {}).get("result")
            tool_use_id = ev.get("tool_use_id") or ev.get("data", {}).get("tool_use_id")
            parts.append(
                f"[tool_confirmation tool_use_id={tool_use_id} result={result}]"
            )
        elif et == "user.custom_tool_result":
            tool_use_id = ev.get("tool_use_id") or ev.get("data", {}).get("tool_use_id")
            content = ev.get("content") or ev.get("data", {}).get("content") or []
            text = "".join(
                str(b.get("text") or "") for b in content if isinstance(b, dict)
            )
            parts.append(f"[custom_tool_result tool_use_id={tool_use_id}] {text}")
    return "\n\n".join(parts)


class BrowserUseDurableAgent(DurableAgent):
    """DurableAgent with the platform ``session_workflow`` wrapper."""

    @workflow_entry
    def session_workflow(self, ctx, message: dict):
        """Session loop bridging the platform dispatch contract onto
        ``agent_workflow`` (executor branch).

        Input shape (produced by the BFF ``ensure-for-workflow`` handler /
        spawn path)::

            {
                "sessionId": "sesn_abc",
                "agentConfig": { ... },
                "initialEvents": [{"type": "user.message", "content": [...]}],
                "autoTerminateAfterEndTurn": true,   # workflow-bridge one-shot
                "dbExecutionId": "...",
            }
        """
        session_id = str(message.get("sessionId") or "")
        if not session_id:
            raise RuntimeError("session_workflow requires sessionId")

        agent_cfg = _coerce_agent_config(message.get("agentConfig"))
        vault_ids = message.get("vaultIds") or []
        db_execution_id = str(message.get("dbExecutionId") or "")
        workflow_instance_id = session_workflow_instance_id(
            getattr(ctx, "instance_id", None), session_id
        )
        continuation_state = session_workflow_state_from_message(message)
        pending = list(message.get("initialEvents") or [])
        auto_terminate = bool(message.get("autoTerminateAfterEndTurn"))
        turn_counter = int(continuation_state["turnCounter"])
        config_revision = int(continuation_state["configRevision"])

        if not ctx.is_replaying:
            publish_session_event(
                session_id,
                "session.status_rescheduled",
                {
                    "vaultIds": vault_ids,
                    **session_native_event_fields(workflow_instance_id),
                },
            )

        while True:
            if not pending:
                if not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.status_idle",
                        {
                            "stop_reason": {"type": "end_turn"},
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
                try:
                    batch = yield ctx.wait_for_external_event("session.user_events")
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "[session] %s wait_for_external_event failed: %s",
                        session_id,
                        exc,
                    )
                    break
                pending = list((batch or {}).get("events") or [])
                if not pending:
                    continue

            agent_cfg, pending, config_changes = apply_session_control_events(
                agent_cfg, pending
            )
            if config_changes:
                config_revision += 1
                if not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.config_updated",
                        {
                            "changes": config_changes,
                            "applies": "next_turn",
                            "configRevision": config_revision,
                            "modelSpec": agent_cfg.get("modelSpec"),
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
                if not pending:
                    continue

            terminal_stop_reason = terminal_stop_reason_from_events(pending)
            if terminal_stop_reason:
                if not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.status_terminating",
                        {
                            "stop_reason": terminal_stop_reason,
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
                    publish_session_event(
                        session_id,
                        "session.status_terminated",
                        {
                            "stop_reason": terminal_stop_reason,
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
                return

            task_text = _compose_turn_task(pending)
            pending = []
            turn_counter += 1
            turn_id = logical_turn_id(session_id, turn_counter)
            agent_turn_instance_id = (
                f"{workflow_instance_id}__turn__{turn_counter}"
                if auto_terminate
                else workflow_instance_id
            )

            if not ctx.is_replaying:
                publish_session_event(
                    session_id,
                    "session.status_running",
                    {
                        "turn": turn_counter,
                        "turnId": turn_id,
                        **session_native_event_fields(workflow_instance_id),
                    },
                )
                publish_session_event(
                    session_id,
                    "session.turn_started",
                    {
                        "turn": turn_counter,
                        "turnId": turn_id,
                        "childInstanceId": agent_turn_instance_id,
                        "configRevision": config_revision,
                        "modelSpec": agent_cfg.get("modelSpec"),
                        **session_native_event_fields(workflow_instance_id),
                    },
                )

            child_input = {
                "task": task_text,
                # Resume the same executor session every turn so a same-pod
                # retry (and, later, cross-pod restore) continues forward.
                "session_id": workflow_instance_id,
                "context": {
                    "sessionId": session_id,
                    "agentConfig": agent_cfg,
                    "turn": turn_counter,
                    "turnId": turn_id,
                    "workflowInstanceId": workflow_instance_id,
                    "cancellationScopeId": agent_turn_instance_id,
                    "dbExecutionId": db_execution_id,
                },
                "_message_metadata": {"source": "session_workflow"},
            }

            try:
                if auto_terminate:
                    # One-shot durable/run turn: real child workflow so the
                    # session wrapper and the executor turn don't share Dapr
                    # action IDs.
                    turn_result = yield ctx.call_child_workflow(
                        getattr(self, "agent_workflow_name", "agent_workflow"),
                        input=child_input,
                        instance_id=agent_turn_instance_id,
                    )
                else:
                    turn_result = yield from self.agent_workflow(ctx, child_input)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[session] %s turn %d failed: %s", session_id, turn_counter, exc
                )
                if not ctx.is_replaying:
                    publish_session_event(
                        session_id,
                        "session.error",
                        {
                            "turn": turn_counter,
                            "turnId": turn_id,
                            "error": str(exc)[:500],
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
                    publish_session_event(
                        session_id,
                        "session.status_terminated",
                        session_native_event_fields(workflow_instance_id),
                    )
                if auto_terminate:
                    return {
                        "success": False,
                        "content": str(exc)[:500],
                        "error": str(exc)[:500],
                        "sessionId": session_id,
                        "turn": turn_counter,
                        **session_native_event_fields(workflow_instance_id),
                    }
                return

            if auto_terminate:
                result_dict = (
                    turn_result
                    if isinstance(turn_result, dict)
                    else {"content": str(turn_result or "")}
                )
                cancelled = bool(result_dict.get("cancelled"))
                if not ctx.is_replaying:
                    if cancelled:
                        stop_reason = (
                            result_dict.get("stop_reason")
                            if isinstance(result_dict.get("stop_reason"), dict)
                            else {"type": "terminated"}
                        )
                        publish_session_event(
                            session_id,
                            "session.status_terminating",
                            {
                                "stop_reason": stop_reason,
                                **session_native_event_fields(workflow_instance_id),
                            },
                        )
                    else:
                        publish_session_event(
                            session_id,
                            "session.status_idle",
                            {
                                "stop_reason": {"type": "end_turn"},
                                **session_native_event_fields(workflow_instance_id),
                            },
                        )
                    publish_session_event(
                        session_id,
                        "session.status_terminated",
                        {
                            "reason": "cancelled"
                            if cancelled
                            else "auto_terminate_after_end_turn",
                            **(
                                {"stop_reason": result_dict.get("stop_reason")}
                                if cancelled
                                and isinstance(result_dict.get("stop_reason"), dict)
                                else {}
                            ),
                            **session_native_event_fields(workflow_instance_id),
                        },
                    )
                result_dict.setdefault("success", not bool(result_dict.get("error")))
                result_dict.setdefault("sessionId", session_id)
                result_dict.setdefault("turn", turn_counter)
                for key, value in session_native_event_fields(
                    workflow_instance_id
                ).items():
                    result_dict.setdefault(key, value)
                return result_dict

    def register_workflows(self, runtime) -> None:
        """Register the base workflows/activities plus ``session_workflow``.

        The base class hard-codes only its own two workflows; without this
        override a ``session_workflow`` dispatch has no registered target
        (same pattern as dapr-agent-py).
        """
        super().register_workflows(runtime)
        runtime.register_workflow(self.session_workflow)
        # dapr-agents 1.0.4 executor-branch bug: agent_workflow yields
        # ctx.call_activity(self.run_executor) with the bound METHOD, which
        # durabletask resolves by __name__ ("run_executor") — but the base
        # class registers only the scoped name
        # ("dapr.agents.<name>.run_executor"). Register the bare name too so
        # the executor branch finds its activity (verified live: without this
        # the turn fails "Activity function named 'run_executor' was not
        # registered!").
        runtime.register_activity(self.run_executor)
