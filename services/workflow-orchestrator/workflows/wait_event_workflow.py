"""``wait_event_workflow_v1`` — the awaitable behind ``approve()`` /
``waitForEvent()`` (contract 1.2.0, cutover P1d).

A tiny deterministic child workflow: journal a waiter marker (so the BFF
approve route can target THIS instance), log the approval-request row (run-UI
banner parity with SW listen gates), then park on
``wait_for_external_event("script.event.<callId>")`` with a bounded timeout.

Timeout RESOLVES ``{timedOut: true}`` — gates never throw for time
(``team.join`` precedent). The pump journals whatever this child returns
through the ``record_script_call_result`` event branch, and the evaluator
resolves the script's promise with it.

Runs as a CHILD of the dynamic-script pump so scripts can hold PARALLEL gates
(unlike the SW interpreter's single-currentNodeId listen gate) and the pump's
``when_any`` stays a flat multiplex.
"""

from __future__ import annotations

import logging
import os
from datetime import timedelta
from typing import Any

import dapr.ext.workflow as wf

from activities.log_external_event import log_approval_request, log_approval_timeout
from activities.script_call_journal import record_script_call_pause
from workflows.sw_workflow import _freeze

logger = logging.getLogger(__name__)

WAIT_EVENT_WORKFLOW_NAME = "wait_event_workflow_v1"

#: Gate timeout bounds (minutes). approve() links routinely wait on humans —
#: default generous, capped at 7 days so an abandoned gate cannot pin a run
#: forever (the script still RESOLVES {timedOut: true} and decides).
_DEFAULT_TIMEOUT_MINUTES = int(
    os.environ.get("DYNAMIC_SCRIPT_EVENT_TIMEOUT_MINUTES", "1440") or "1440"
)
_MAX_TIMEOUT_MINUTES = 7 * 24 * 60


def wait_event_workflow(ctx: wf.DaprWorkflowContext, input_data: dict) -> Any:
    """Marker → approval-request row → bounded external-event wait."""
    event_name = str(input_data.get("eventName") or "").strip()
    journal = input_data.get("journal") if isinstance(input_data.get("journal"), dict) else {}
    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    label = str(input_data.get("label") or "").strip()
    logical_name = str(input_data.get("logicalName") or "").strip() or "event"

    if not event_name:
        return {"success": False, "error": "wait_event: eventName is required"}

    try:
        timeout_minutes = int(input_data.get("timeoutMinutes") or _DEFAULT_TIMEOUT_MINUTES)
    except (TypeError, ValueError):
        timeout_minutes = _DEFAULT_TIMEOUT_MINUTES
    timeout_minutes = max(1, min(timeout_minutes, _MAX_TIMEOUT_MINUTES))

    db_execution_id = journal.get("executionId")

    # Waiter marker: the BFF approve/raise route reads result.pause off the
    # call's running journal row to raise the event at THIS child.
    yield ctx.call_activity(
        record_script_call_pause,
        input=_freeze(
            {
                "executionId": db_execution_id,
                "callId": journal.get("callId"),
                "seq": journal.get("seq"),
                "spec": journal.get("spec") or {},
                "pause": {
                    "type": "EVENT",
                    "eventName": event_name,
                    "logicalName": logical_name,
                    "waiterInstanceId": ctx.instance_id,
                    "timeoutMinutes": timeout_minutes,
                    **({"message": input_data.get("message")} if input_data.get("message") else {}),
                },
                "_otel": otel,
            }
        ),
    )

    # Approval-request row — the same run-UI banner the SW listen gate gets.
    if db_execution_id:
        yield ctx.call_activity(
            log_approval_request,
            input=_freeze(
                {
                    "executionId": ctx.instance_id,
                    "taskName": label or logical_name,
                    "eventType": event_name,
                    "dbExecutionId": db_execution_id,
                    "_otel": otel,
                }
            ),
        )

    try:
        data = yield ctx.wait_for_external_event(
            event_name, timeout=timedelta(minutes=timeout_minutes)
        )
        if not ctx.is_replaying:
            logger.info("[wait-event] %s received %s", ctx.instance_id, event_name)
        return data if isinstance(data, dict) else {"value": data}
    except TimeoutError:
        if db_execution_id:
            yield ctx.call_activity(
                log_approval_timeout,
                input=_freeze(
                    {
                        "executionId": ctx.instance_id,
                        "taskName": label or logical_name,
                        "eventType": event_name,
                        "dbExecutionId": db_execution_id,
                        "_otel": otel,
                    }
                ),
            )
        return {"timedOut": True}
