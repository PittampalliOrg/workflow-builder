"""``action_runner_workflow_v1`` — durable runner for ONE ActivePieces
``action()`` call (contract 1.2.0, cutover P1c).

AP pieces carry the SW durability contract that a plain activity cannot
express: the piece may PAUSE (``DELAY`` → durable timer then RESUME re-invoke;
``WEBHOOK`` → wait for the BFF-raised ``ap.resume.<requestId>`` external event
then RESUME re-invoke carrying the callback payload), bounded by
``AP_MAX_PAUSE_ROUNDS``. Running it as a CHILD of the dynamic-script pump keeps
the pump's ``when_any`` set a flat multiplex (``team_join_workflow_v1``
precedent) and gives the WEBHOOK wait a stable waiter instance id the BFF
ap-resume route can target.

On a WEBHOOK pause the runner journals a pause marker into the call's running
``workflow_script_calls`` row (``result.pause = {type, requestId,
waiterInstanceId}``) — the ap-resume route reads it to raise the event at THIS
child instead of the root pump instance (which is not the waiter here, unlike
the SW interpreter where the root IS the waiter).

Returns the final ``ActivityExecutionResult`` dict verbatim; the pump journals
it through the normal ``record_script_call_result`` action branch.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

import dapr.ext.workflow as wf

from activities.execute_action import execute_action
from activities.script_call_journal import record_script_call_pause

# The AP durability knobs are defined next to the SW interpreter's AP path —
# reuse them so scripts and SW specs keep ONE retry/pause contract.
from workflows.sw_workflow import (
    _AP_MAX_PAUSE_ROUNDS,
    _AP_RETRY_POLICY,
    _expects_durable_dev_preview_activation,
    _freeze,
    _run_durable_dev_preview_activation,
)

logger = logging.getLogger(__name__)

ACTION_RUNNER_WORKFLOW_NAME = "action_runner_workflow_v1"


def action_runner_workflow(ctx: wf.DaprWorkflowContext, input_data: dict) -> Any:
    """BEGIN → (pause → resume)* → final result. See module docstring."""
    activity_input = (
        input_data.get("activityInput")
        if isinstance(input_data.get("activityInput"), dict)
        else {}
    )
    journal = input_data.get("journal") if isinstance(input_data.get("journal"), dict) else {}
    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}

    # dev/preview activation (cutover P3 / blocker B1): preview-native adopt
    # runs are NOT single-shot — the SW interpreter polls a strict batch/ready
    # set with durable timers before continuing. Reuse that exact generator here
    # so a script's action('dev/preview', {mode:'preview-native', services:[…]})
    # gets the same readiness contract (the GAN / preview / dev-session producer
    # ports depend on it).
    node_config = (
        activity_input.get("node", {}).get("config")
        if isinstance(activity_input.get("node"), dict)
        else None
    )
    action_type = node_config.get("actionType") if isinstance(node_config, dict) else None
    if isinstance(action_type, str) and _expects_durable_dev_preview_activation(
        action_type, node_config
    ):
        return (
            yield from _run_durable_dev_preview_activation(
                ctx,
                activity_input=_freeze({**activity_input, "executionType": "BEGIN"}),
                call_kwargs={},
                config=node_config,
                execution_id=str(
                    (journal.get("executionId") if isinstance(journal, dict) else "") or ""
                ),
                task_name=str(journal.get("callId") or "action") if isinstance(journal, dict) else "action",
            )
        )

    result = yield ctx.call_activity(
        execute_action,
        input=_freeze({**activity_input, "executionType": "BEGIN"}),
        retry_policy=_AP_RETRY_POLICY,
    )

    pause_rounds = 0
    while (
        isinstance(result, dict)
        and isinstance(result.get("pause"), dict)
        and pause_rounds < _AP_MAX_PAUSE_ROUNDS
    ):
        pause_rounds += 1
        pause = result["pause"]
        pause_type = pause.get("type")
        resume_payload: Any = None

        if pause_type == "DELAY":
            delay_seconds = int(pause.get("delaySeconds") or 0)
            if not ctx.is_replaying:
                logger.info(
                    "[action-runner] %s paused (DELAY %ss, round %s)",
                    ctx.instance_id,
                    delay_seconds,
                    pause_rounds,
                )
            if delay_seconds > 0:
                yield ctx.create_timer(timedelta(seconds=delay_seconds))
        elif pause_type == "WEBHOOK":
            request_id = str(pause.get("requestId") or "").strip()
            if not request_id:
                # Deterministic failure — the pump journals it as action_error.
                return {
                    "success": False,
                    "error": "AP WEBHOOK pause is missing requestId",
                }
            # Journal the pause marker so the BFF ap-resume route can find the
            # waiter (THIS child) from the requestId. Best-effort inside the
            # activity (a failed write degrades to the SW-era behavior: the
            # route raises at the root and the resume is lost — visible in the
            # run rail as a stuck running row).
            yield ctx.call_activity(
                record_script_call_pause,
                input=_freeze(
                    {
                        "executionId": journal.get("executionId"),
                        "callId": journal.get("callId"),
                        "seq": journal.get("seq"),
                        "spec": journal.get("spec") or {},
                        "pause": {
                            "type": "WEBHOOK",
                            "requestId": request_id,
                            "waiterInstanceId": ctx.instance_id,
                        },
                        "_otel": otel,
                    }
                ),
            )
            if not ctx.is_replaying:
                logger.info(
                    "[action-runner] %s paused (WEBHOOK, waiting for ap.resume.%s)",
                    ctx.instance_id,
                    request_id,
                )
            resume_payload = yield ctx.wait_for_external_event(f"ap.resume.{request_id}")
        else:
            break

        result = yield ctx.call_activity(
            execute_action,
            input=_freeze(
                {
                    **activity_input,
                    "executionType": "RESUME",
                    "resumePayload": resume_payload,
                }
            ),
            retry_policy=_AP_RETRY_POLICY,
        )

    return result
