"""Deterministic LIFECYCLE workflow for the `claude-code-cli` runtime.

Unlike claude-agent-py's per-turn loop, the user drives the Claude Code TUI
through the web terminal — the workflow does NOT drive turns. It is a durable
lifecycle wrapper: seed → start the TUI in a herdr pane → wait for lifecycle
events (turn.completed bookkeeping, cli.exited / cli.session_end /
session.terminate termination) with a periodic out-of-band liveness probe →
cooperative stop → emit session.status_terminated + return the runtime
contract dict.

History is bounded via ``ctx.continue_as_new`` every ~CLI_LIFECYCLE_MAX_ITERATIONS
when_any cycles, carrying {turnCount, lastAssistantText, paneRef, seeded: true}.
"""

from __future__ import annotations

import logging
import os
from datetime import timedelta
from typing import Any, Generator, Mapping

from dapr.ext.workflow import DaprWorkflowContext, RetryPolicy, when_any as wf_when_any

from src.cancellation import TERMINAL_CONTROL_EVENT_TYPES, check_cancellation_activity
from src.cli_lifecycle import probe_cli_activity, start_cli_activity, stop_cli_activity
from src.event_publisher import publish_session_event
from src.seed import seed_session_activity
from src.taskhub import LIFECYCLE_EVENT_NAME

logger = logging.getLogger(__name__)

CLI_IDLE_PROBE_SECONDS = int(os.environ.get("CLI_IDLE_PROBE_SECONDS", "600"))
CLI_LIFECYCLE_MAX_ITERATIONS = int(os.environ.get("CLI_LIFECYCLE_MAX_ITERATIONS", "50"))

_SEED_RETRY_POLICY = RetryPolicy(
    max_number_of_attempts=3,
    first_retry_interval=timedelta(seconds=5),
    backoff_coefficient=2,
    max_retry_interval=timedelta(seconds=30),
)
_START_RETRY_POLICY = RetryPolicy(
    max_number_of_attempts=2,
    first_retry_interval=timedelta(seconds=5),
    backoff_coefficient=2,
    max_retry_interval=timedelta(seconds=30),
)


def _clean_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _session_id(input_data: Mapping[str, Any]) -> str | None:
    return _clean_string(input_data.get("sessionId"))


def _extract_seed_user_message(input_data: Mapping[str, Any]) -> str | None:
    """The kickoff prompt — the first ``user.message`` the BFF stamps into
    ``childInput.initialEvents`` at session create (mirrors claude-agent-py).
    Falls back to the ``x-workflow-builder.input`` block for canvas-launched
    runs. Returned to start_cli, which arms the readiness-gated injection."""
    initial_events = input_data.get("initialEvents")
    if isinstance(initial_events, list):
        for event in initial_events:
            if not isinstance(event, Mapping) or event.get("type") != "user.message":
                continue
            content = event.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
            if isinstance(content, list):
                parts: list[str] = []
                for item in content:
                    if isinstance(item, str) and item.strip():
                        parts.append(item.strip())
                    elif isinstance(item, Mapping):
                        text = item.get("text")
                        if isinstance(text, str) and text.strip():
                            parts.append(text.strip())
                if parts:
                    return "\n".join(parts)
    with_block = _record(input_data.get("with"))
    wb = _record(with_block.get("x-workflow-builder"))
    return _clean_string(wb.get("input"))


def _event_batch(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, Mapping):
        events = payload.get("events")
        if isinstance(events, list):
            return [dict(event) for event in events if isinstance(event, Mapping)]
        return [dict(payload)]
    return []


def _result_contract(
    *,
    ctx: DaprWorkflowContext,
    session_id: str | None,
    status: str,
    last_assistant_text: str,
    turn_count: int,
) -> dict[str, Any]:
    return {
        "success": status not in ("failed",),
        "status": status,
        "output": last_assistant_text or "",
        "content": last_assistant_text or "",
        "sessionId": session_id,
        "agentRuntime": "claude-code-cli",
        "childWorkflowName": "session_workflow",
        "daprInstanceId": ctx.instance_id,
        "turnCount": turn_count,
    }


def session_workflow(
    ctx: DaprWorkflowContext, input_data: dict[str, Any]
) -> Generator[Any, Any, dict[str, Any] | None]:
    # Defense-in-depth: the orchestrator already refuses to dispatch
    # autoTerminateAfterEndTurn runs to interactive-cli runtimes.
    if input_data.get("autoTerminateAfterEndTurn"):
        raise ValueError(
            "claude-code-cli is an interactive runtime: autoTerminateAfterEndTurn "
            "(workflow-driven single-turn) dispatch is not supported"
        )

    session_id = _session_id(input_data)
    carried = _record(input_data.get("_carried"))
    seeded = bool(carried.get("seeded"))
    turn_count = int(carried.get("turnCount") or 0)
    last_assistant_text = str(carried.get("lastAssistantText") or "")
    pane_ref = _clean_string(carried.get("paneRef"))

    if not seeded:
        if session_id and not ctx.is_replaying:
            publish_session_event(session_id, "session.status_starting", {})
        seed_result = yield ctx.call_activity(
            seed_session_activity,
            input=dict(input_data),
            retry_policy=_SEED_RETRY_POLICY,
        )
        start_result = yield ctx.call_activity(
            start_cli_activity,
            input={
                "sessionId": session_id,
                "instanceId": ctx.instance_id,
                "agentConfig": _record(input_data.get("agentConfig")),
                "seed": _record(seed_result),
                # Kickoff prompt: start_cli arms a readiness-gated injection so
                # it is typed into the TUI only once it has booted to its prompt.
                "seedUserMessage": _extract_seed_user_message(input_data),
                "workspaceRef": input_data.get("workspaceRef"),
                "sandboxName": input_data.get("sandboxName"),
            },
            retry_policy=_START_RETRY_POLICY,
        )
        pane_ref = _clean_string(_record(start_result).get("paneRef"))

    status: str | None = None
    reason: str | None = None
    iterations = 0
    while status is None:
        iterations += 1
        if iterations > CLI_LIFECYCLE_MAX_ITERATIONS:
            ctx.continue_as_new(
                {
                    **input_data,
                    "_carried": {
                        "seeded": True,
                        "turnCount": turn_count,
                        "lastAssistantText": last_assistant_text,
                        "paneRef": pane_ref,
                    },
                }
            )
            return None

        event_task = ctx.wait_for_external_event(LIFECYCLE_EVENT_NAME)
        timer_task = ctx.create_timer(timedelta(seconds=CLI_IDLE_PROBE_SECONDS))
        winner = yield wf_when_any([event_task, timer_task])

        if winner is timer_task:
            # Out-of-band liveness probe — also honors a cooperative-cancel
            # flag persisted by the raise-event endpoint in case the raised
            # terminal event was lost.
            cancellation = yield ctx.call_activity(
                check_cancellation_activity, input={"instanceId": ctx.instance_id}
            )
            if isinstance(cancellation, Mapping) and cancellation.get("cancelled"):
                status, reason = "terminated", "cancel_requested"
                break
            probe = yield ctx.call_activity(
                probe_cli_activity,
                input={
                    "paneRef": pane_ref,
                    "sessionId": session_id,
                    "instanceId": ctx.instance_id,
                },
            )
            probe_data = _record(probe)
            if probe_data.get("terminal"):
                status = _clean_string(probe_data.get("status")) or "completed"
                reason = _clean_string(probe_data.get("reason")) or "cli_exited"
                break
            continue

        for event in _event_batch(winner.get_result()):
            event_type = event.get("type")
            if event_type == "turn.completed":
                turn_count += 1
                text = _clean_string(
                    event.get("lastAssistantText") or event.get("content")
                )
                if text:
                    last_assistant_text = text
                continue
            if event_type in ("cli.session_end", "cli.exited"):
                exit_code = event.get("exitCode")
                status = "completed" if exit_code in (None, 0) else "failed"
                reason = _clean_string(event.get("reason")) or str(event_type)
                break
            if event_type in TERMINAL_CONTROL_EVENT_TYPES or event_type == "terminate":
                status, reason = "terminated", str(event_type)
                break

    # Cooperative close — idempotent; tolerates the pane already being gone.
    yield ctx.call_activity(
        stop_cli_activity,
        input={
            "paneRef": pane_ref,
            "sessionId": session_id,
            "instanceId": ctx.instance_id,
            "reason": reason,
        },
    )

    if session_id and not ctx.is_replaying:
        publish_session_event(
            session_id, "session.status_terminated", {"reason": reason or status}
        )
    return _result_contract(
        ctx=ctx,
        session_id=session_id,
        status=status,
        last_assistant_text=last_assistant_text,
        turn_count=turn_count,
    )
