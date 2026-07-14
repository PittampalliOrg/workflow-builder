"""``dynamic_script_workflow_v1`` — the dynamic-script re-execution pump.

A user-authored JS orchestration script cannot run inside the Python generator
orchestrator, so this Dapr-durable workflow loops: aggregate budget → re-run the
whole script in the stateless ``script-evaluator`` (which resolves journaled
``agent()`` calls and returns NEW tasks / done / script_error) → dispatch new
tasks under caps → ``when_any`` over [cancel, control, *outstanding] → drain ALL
completed children → journal → loop.

Design anchors (plan §Architecture, §Workstream 2):
  * The journal lives in ``workflow_script_calls`` (DB), NOT in activity inputs
    (flaw #1); ``evaluate_script`` loads it and forwards over HTTP.
  * ``when_any`` winner is the child ``Task`` object (identity compare); losing
    tasks re-attach to later composites; drain-all-completed is replay-safe.
  * cancel event: ``wait_for_external_event("workflow.cancel")`` created ONCE;
    control event: ``wait_for_external_event("script.call.control")`` re-created
    after each firing.
  * structured-output retry = a NEW corrective session (instance ``__run__<N>``);
    ``record_script_call_result`` decides done/null/error/retry_structured.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import timedelta
from typing import Any

import dapr.ext.workflow as wf
from dapr.ext.workflow import when_all as wf_when_all

from workflows.session_host_wait import wait_for_prepared_agent_hosts
from dapr.ext.workflow import when_any as wf_when_any

from activities.aggregate_script_usage import aggregate_script_usage
from activities.evaluate_script import evaluate_script
from activities.append_script_logs import append_script_logs
from activities.persist_results_to_db import persist_results_to_db
from activities.prepare_script_call import prepare_script_call
from activities.request_session_stop import request_session_stop
from activities.script_call_journal import (
    import_script_journal,
    record_script_call_dispatch,
    record_script_call_result,
)
from activities.track_agent_run import (
    track_agent_run_scheduled,
    track_agent_run_completed,
)
from activities.log_node_execution import update_execution_node
from workflows.script_agent_dispatch import (
    _start_script_call,
    script_child_instance_id,
    start_action_call,
    start_event_wait_call,
    start_prepared_script_call,
    start_team_call,
)
from activities.team_ops import execute_team_op
from workflows.sw_workflow import _freeze

logger = logging.getLogger(__name__)

DYNAMIC_SCRIPT_WORKFLOW_NAME = "dynamic_script_workflow_v1"

CANCEL_EVENT_NAME = "workflow.cancel"
CONTROL_EVENT_NAME = "script.call.control"
DISPATCH_MODE_SERIAL_V1 = "serial-v1"
DISPATCH_MODE_BATCH_V2 = "batch-v2"

#: Task kinds every orchestrator build implements. A kind outside the run's
#: allowed set journals a dispatch error, never falls through to the
#: kind-default "agent" (a phantom empty-prompt session) — the contract-1.2.0
#: version-skew guard (docs/code-first-cutover.md item 11).
KNOWN_TASK_KINDS = {"agent", "workflow", "team"}

#: Contract-1.2.0 kinds, enabled per-run by input `features.actions` (stamped
#: by the BFF from DYNAMIC_SCRIPT_ACTIONS_ENABLED at start — input-derived so
#: replay is deterministic across env flips). These dispatch OUTSIDE the agent
#: slots under their own caps: a deterministic activity, a durable timer, or an
#: approval/event gate must never consume (or starve behind) agent concurrency.
ACTION_CLASS_KINDS = {"action", "sleep", "event"}

# Politeness caps (above Kueue admission). Input limits are clamped by env.
DEFAULT_MAX_CONCURRENCY = int(os.environ.get("DYNAMIC_SCRIPT_MAX_CONCURRENCY", "5") or "5")
DEFAULT_MAX_AGENT_CALLS = int(os.environ.get("DYNAMIC_SCRIPT_MAX_AGENT_CALLS", "50") or "50")
DEFAULT_MAX_LIFETIME_AGENTS = 1000
DEFAULT_MAX_STRUCTURED_RETRIES = 5
DEFAULT_MAX_CONCURRENT_ACTIONS = int(
    os.environ.get("DYNAMIC_SCRIPT_MAX_CONCURRENT_ACTIONS", "16") or "16"
)
DEFAULT_MAX_ACTION_CALLS = int(os.environ.get("DYNAMIC_SCRIPT_MAX_ACTION_CALLS", "500") or "500")
MAX_SLEEP_SECONDS = int(os.environ.get("DYNAMIC_SCRIPT_MAX_SLEEP_SECONDS", "86400") or "86400")
# Post-drain settle delay before the next budget aggregate (see the
# usage-settle gate in the pump loop). Only applies to budget-bounded runs.
USAGE_SETTLE_SECONDS = int(os.environ.get("DYNAMIC_SCRIPT_USAGE_SETTLE_SECONDS", "3") or "3")

# Retry policy applied to EVERY BFF-invoking activity (not just evaluate_script).
# A transient BFF/daprd blip — e.g. a workflow-builder pod rollover deregistering
# its sidecar mid-run — must NOT terminally fail an otherwise-durable run: without
# a retry policy the raised ERR_DIRECT_INVOKE propagates out of the workflow
# generator and the whole run goes FAILED (observed on dev 2026-07-09, a journal
# write at record_script_call_result died on a BFF rollover). Semantics (cloned
# from sw_workflow._AP_RETRY_POLICY): transport / 5xx failures RAISE and are
# retried; 4xx are returned as (non-retryable) errors by the activity itself. All
# journal/persist/track activities are idempotent PUTs/upserts (or read-only), so
# re-invocation on retry is safe.
_BFF_ACTIVITY_RETRY_POLICY = wf.RetryPolicy(
    first_retry_interval=timedelta(
        seconds=int(os.environ.get("SCRIPT_EVAL_RETRY_FIRST_INTERVAL_SECONDS", "2"))
    ),
    max_number_of_attempts=int(os.environ.get("SCRIPT_EVAL_RETRY_MAX_ATTEMPTS", "5")),
    backoff_coefficient=float(os.environ.get("SCRIPT_EVAL_RETRY_BACKOFF_COEFFICIENT", "2")),
    max_retry_interval=timedelta(
        seconds=int(os.environ.get("SCRIPT_EVAL_RETRY_MAX_INTERVAL_SECONDS", "60"))
    ),
)
# Backwards-compatible alias (evaluate_script's call site + docstrings keep working).
_SCRIPT_EVAL_RETRY_POLICY = _BFF_ACTIVITY_RETRY_POLICY


def _as_int(value: Any, default: int) -> int:
    try:
        if isinstance(value, bool):
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def _clamp_limits(input_limits: dict[str, Any]) -> dict[str, int]:
    """Resolve effective caps from input ∩ env politeness bounds."""
    max_concurrent = min(
        _as_int(input_limits.get("maxConcurrentAgents"), DEFAULT_MAX_CONCURRENCY),
        DEFAULT_MAX_CONCURRENCY,
    )
    max_concurrent = max(1, max_concurrent)
    max_lifetime = min(
        _as_int(input_limits.get("maxLifetimeAgents"), DEFAULT_MAX_LIFETIME_AGENTS),
        DEFAULT_MAX_AGENT_CALLS,
    )
    max_lifetime = max(1, max_lifetime)
    max_structured = _as_int(
        input_limits.get("maxStructuredRetries"), DEFAULT_MAX_STRUCTURED_RETRIES
    )
    max_concurrent_actions = min(
        _as_int(input_limits.get("maxConcurrentActions"), DEFAULT_MAX_CONCURRENT_ACTIONS),
        DEFAULT_MAX_CONCURRENT_ACTIONS,
    )
    max_lifetime_actions = min(
        _as_int(input_limits.get("maxLifetimeActions"), DEFAULT_MAX_ACTION_CALLS),
        DEFAULT_MAX_ACTION_CALLS,
    )
    return {
        "maxConcurrentAgents": max_concurrent,
        "maxLifetimeAgents": max_lifetime,
        "maxItemsPerCall": _as_int(input_limits.get("maxItemsPerCall"), 4096),
        "maxStructuredRetries": max_structured,
        "maxConcurrentActions": max(1, max_concurrent_actions),
        "maxLifetimeActions": max(1, max_lifetime_actions),
    }


def _custom_status_payload(
    *,
    phase: str,
    declared_phases: list[str],
    dispatched: int,
    outstanding: int,
    resolved: int,
    budget: dict[str, Any],
    estimated: int | None,
) -> dict[str, Any]:
    progress = 0
    if estimated and estimated > 0:
        progress = min(100, round(100 * dispatched / estimated))
    return {
        "phase": phase,
        "progress": progress,
        "declaredPhases": declared_phases,
        "dispatched": dispatched,
        "outstanding": outstanding,
        "resolved": resolved,
        "budget": budget,
    }


def dynamic_script_workflow(ctx: wf.DaprWorkflowContext, input_data: dict) -> dict:
    """The re-execution pump. See module docstring for the loop shape."""
    exec_id = str(input_data.get("executionId") or input_data.get("dbExecutionId") or "").strip()
    script = input_data.get("script") or ""
    script_sha256 = input_data.get("scriptSha256") or ""
    meta = input_data.get("meta") if isinstance(input_data.get("meta"), dict) else {}
    # args is the script's VERBATIM input — any JSON value (object/array/scalar/
    # null). Key-absence is meaningful: no key -> the script's `args` global is
    # undefined (Workflow-tool parity), so track presence rather than defaulting.
    has_args = "args" in input_data
    args = input_data.get("args")
    nested = bool(input_data.get("nested"))
    # Deployment capabilities — INPUT-derived (the BFF stamps them at start from
    # DYNAMIC_SCRIPT_ACTIONS_ENABLED) so replay stays deterministic across env
    # flips; nested workflow() children inherit the parent's features.
    features = input_data.get("features") if isinstance(input_data.get("features"), dict) else {}
    actions_enabled = features.get("actions") is True
    allowed_kinds = KNOWN_TASK_KINDS | (ACTION_CLASS_KINDS if actions_enabled else set())
    budget_total = input_data.get("budgetTotal")
    journal_import_from = input_data.get("journalImportFromExecutionId")
    limits = _clamp_limits(
        input_data.get("limits") if isinstance(input_data.get("limits"), dict) else {}
    )
    defaults = input_data.get("defaults") if isinstance(input_data.get("defaults"), dict) else {}
    workflow_id = input_data.get("workflowId")
    user_id = input_data.get("userId")
    project_id = input_data.get("projectId")
    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    dispatch_mode = str(input_data.get("dispatchMode") or DISPATCH_MODE_SERIAL_V1).strip()
    if dispatch_mode != DISPATCH_MODE_BATCH_V2:
        dispatch_mode = DISPATCH_MODE_SERIAL_V1
    estimated = None
    if isinstance(meta.get("estimatedAgentCalls"), (int, float)):
        estimated = int(meta["estimatedAgentCalls"])

    # Journal import (resume-after-edit). Only at the top level.
    if journal_import_from and not nested:
        yield ctx.call_activity(
            import_script_journal,
            input=_freeze(
                {"executionId": exec_id, "fromExecutionId": journal_import_from, "_otel": otel}
            ),
            retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
        )

    # ---- pump state (all deterministic) ------------------------------------
    queue: list[str] = []            # callIds pending dispatch (insertion order)
    outstanding: dict[str, Any] = {}  # callId -> in-flight child Task (insertion-ordered)
    task_specs: dict[str, dict[str, Any]] = {}  # callId -> spec (kind/opts/retries/feedback/...)
    resolved: set[str] = set()        # terminally journaled callIds
    seen_log_count = 0
    dispatched = 0
    dispatched_actions = 0
    seq_counter = 0
    lifetime_exceeded = False
    last_status_json: str | None = None
    current_phase = ""
    declared_phases: list[str] = []
    # Any team.* call dispatched this run → auto-shutdown teammates at terminal
    # (deterministic: set only from journaled dispatch decisions).
    team_used = False

    # cancel task: created ONCE. control task: re-created after each firing.
    cancel_task = ctx.wait_for_external_event(CANCEL_EVENT_NAME)
    control_task = ctx.wait_for_external_event(CONTROL_EVENT_NAME)

    def _set_status(phase: str, budget: dict[str, Any]) -> None:
        nonlocal last_status_json
        payload = _custom_status_payload(
            phase=phase,
            declared_phases=declared_phases,
            dispatched=dispatched,
            outstanding=len(outstanding),
            resolved=len(resolved),
            budget=budget,
            estimated=estimated,
        )
        encoded = json.dumps(payload, sort_keys=True)
        if encoded != last_status_json:
            ctx.set_custom_status(encoded)
            last_status_json = encoded

    while True:
        # Unknown-kind guard resolutions this round (counts as progress at the
        # no-dispatchable-work check, like resolved_at_dispatch).
        skew_resolved_this_round = 0

        # 1. Budget (skip aggregation when unbounded).
        if budget_total is not None:
            usage = yield ctx.call_activity(
                aggregate_script_usage,
                input=_freeze({"executionId": exec_id, "_otel": otel}),
                retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
            )
            spent = _as_int((usage or {}).get("totalTokens"), 0)
            budget = {
                "total": budget_total,
                "spent": spent,
                "exhausted": spent >= _as_int(budget_total, 0),
                "lifetimeExceeded": lifetime_exceeded,
            }
        else:
            budget = {
                "total": None,
                "spent": 0,
                "exhausted": False,
                "lifetimeExceeded": lifetime_exceeded,
            }

        # 2. Evaluate (re-run the whole script; resolve journaled calls).
        evaluate_input = {
            "executionId": exec_id,
            "script": script,
            "scriptSha256": script_sha256,
            "meta": meta,
            "nested": nested,
            "budget": budget,
            "knownCallIds": sorted(resolved),
            "seenLogCount": seen_log_count,
            "limits": {"maxItemsPerCall": limits["maxItemsPerCall"]},
            "_otel": otel,
        }
        if has_args:
            evaluate_input["args"] = args
        if actions_enabled:
            evaluate_input["features"] = {"actions": True}
        plan = yield ctx.call_activity(
            evaluate_script,
            input=_freeze(evaluate_input),
            retry_policy=_SCRIPT_EVAL_RETRY_POLICY,
        )
        plan = plan if isinstance(plan, dict) else {}
        status = plan.get("status")
        phases = plan.get("phases") if isinstance(plan.get("phases"), dict) else {}
        if isinstance(phases.get("declared"), list):
            declared_phases = [str(p) for p in phases["declared"]]
        if phases.get("current"):
            current_phase = str(phases["current"])

        # 3. Logs (append-only, delta) + custom status (delta).
        new_logs = plan.get("newLogs") if isinstance(plan.get("newLogs"), list) else []
        if new_logs:
            yield ctx.call_activity(
                append_script_logs,
                input=_freeze(
                    {
                        "executionId": exec_id,
                        "logs": new_logs,
                        "startIndex": seen_log_count,
                        "_otel": otel,
                    }
                ),
                retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
            )
            seen_log_count += len(new_logs)
        _set_status(current_phase or "running", budget)

        # Terminal outcomes. Each persists output/status to workflow_executions
        # first — the read-model reconciler maps Dapr COMPLETED→success blindly,
        # so a returned-but-failed run (script_error/cancelled) would otherwise
        # read as success with null output (found in dev verification).
        #
        # NESTED runs must NOT persist: a workflow() child shares the ROOT run's
        # executionId, so its terminal persist would clobber the shared row
        # (live-caught: a fast child flipped the row to success with the CHILD's
        # returnValue mid-run, and the parent's later patch could not land). A
        # nested child's result reaches the parent via the child-workflow return
        # value -> record_script_call_result; the row belongs to the root alone.
        if status == "done":
            _set_status(current_phase or "completed", budget)
            yield from _team_auto_shutdown(ctx, exec_id, team_used and not nested, otel)
            if not nested:
                yield ctx.call_activity(
                    persist_results_to_db,
                    input=_freeze(
                        {
                            "executionId": ctx.instance_id,
                            "dbExecutionId": exec_id,
                            "success": True,
                            "workflowOutput": plan.get("returnValue"),
                            "outputs": {"returnValue": plan.get("returnValue")},
                            "phase": current_phase or "completed",
                            "_otel": otel,
                        }
                    ),
                    retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                )
            return {
                "success": True,
                "status": "completed",
                "returnValue": plan.get("returnValue"),
                "phases": phases,
                "counts": plan.get("counts"),
                "dispatched": dispatched,
                "logCount": seen_log_count,
                "evaluatorVersion": plan.get("evaluatorVersion"),
            }
        if status == "script_error":
            error = plan.get("error") if isinstance(plan.get("error"), dict) else {}
            _set_status(current_phase or "failed", budget)
            yield from _team_auto_shutdown(ctx, exec_id, team_used and not nested, otel)
            if not nested:
                yield ctx.call_activity(
                    persist_results_to_db,
                    input=_freeze(
                        {
                            "executionId": ctx.instance_id,
                            "dbExecutionId": exec_id,
                            "success": False,
                            "error": error.get("message") or "script error",
                            "phase": current_phase or "failed",
                            "_otel": otel,
                        }
                    ),
                    retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                )
            return {
                "success": False,
                "status": "script_error",
                "error": error.get("message") or "script error",
                "stack": error.get("stack"),
                "phases": phases,
                "dispatched": dispatched,
                "logCount": seen_log_count,
                "evaluatorVersion": plan.get("evaluatorVersion"),
            }

        # status == "need": enqueue new tasks (dedup vs resolved/outstanding/queue).
        for task in plan.get("tasks") or []:
            if not isinstance(task, dict):
                continue
            cid = str(task.get("callId") or "").strip()
            if not cid or cid in resolved or cid in outstanding or cid in queue:
                continue
            spec = task_specs.get(cid) or {"retries": 0}
            spec.update(
                {
                    "kind": task.get("kind") or "agent",
                    "prompt": task.get("prompt") or "",
                    "opts": task.get("opts") if isinstance(task.get("opts"), dict) else {},
                    "baseHash": task.get("baseHash"),
                    "occurrence": task.get("occurrence"),
                    "workflowRef": task.get("workflowRef"),
                    "teamOp": task.get("teamOp"),
                    # Contract-1.2.0 action-class carriers (None for other kinds).
                    "actionSlug": task.get("actionSlug"),
                    "actionOpts": (
                        task.get("actionOpts") if isinstance(task.get("actionOpts"), dict) else None
                    ),
                    "seconds": task.get("seconds"),
                    "eventName": task.get("eventName"),
                    "eventOpts": (
                        task.get("eventOpts") if isinstance(task.get("eventOpts"), dict) else None
                    ),
                }
            )
            # workflow() child args: VERBATIM any-JSON value; key-absence means
            # the parent passed nothing (child's `args` global -> undefined).
            if "args" in task:
                spec["args"] = task.get("args")
            opts = spec["opts"]
            spec["label"] = opts.get("label")
            if (spec.get("kind") or "agent") == "team" and not spec.get("label"):
                # Human rail label for team ops ("spawn researcher", 'task "..."').
                # Pure function of replayed inputs — replay-safe.
                spec["label"] = _team_call_label(spec.get("teamOp"), spec.get("args"))
            spec["phase"] = opts.get("phase")
            spec["schema"] = opts.get("schema") if isinstance(opts.get("schema"), dict) else None
            spec["promptSha256"] = hashlib.sha256(
                str(spec.get("prompt") or "").encode("utf-8")
            ).hexdigest()
            spec["maxStructuredRetries"] = limits["maxStructuredRetries"]
            spec.setdefault("retries", 0)
            task_specs[cid] = spec
            if str(spec.get("kind") or "agent") not in allowed_kinds:
                # Version-skew / feature-gate guard: journal a dispatch error and
                # resolve — never enqueue a kind outside the run's allowed set
                # (it would dispatch as a phantom agent session). Deploy
                # orchestrator >= evaluator; action-class kinds additionally
                # require input features.actions.
                spec["seq"] = seq_counter
                seq_counter += 1
                yield ctx.call_activity(
                    record_script_call_result,
                    input=_freeze(
                        {
                            "executionId": exec_id,
                            "callId": cid,
                            "seq": spec["seq"],
                            "spec": _spec_for_journal(spec),
                            "raw": {
                                "success": False,
                                "error": (
                                    f"unknown task kind {spec.get('kind')!r}: this "
                                    "orchestrator does not implement it (contract 1.2.0 "
                                    "reserves action/sleep/event; deploy orchestrator >= "
                                    "evaluator)"
                                ),
                            },
                            "_otel": otel,
                        }
                    ),
                    retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                )
                resolved.add(cid)
                skew_resolved_this_round += 1
                continue
            queue.append(cid)

        # 4. Dispatch under caps.
        dispatched_this_round = 0
        resolved_at_dispatch = 0  # calls journaled terminal AT dispatch (no child)

        # 4-pre. Action-class kinds (action/sleep/event) dispatch OUTSIDE the
        # agent slots under their own caps — a deterministic activity, durable
        # timer, or approval gate must never consume (or starve behind) agent
        # concurrency. Both dispatch modes share this pre-pass; over-cap calls
        # defer to the next round.
        if actions_enabled:
            action_pending = [
                c
                for c in queue
                if (task_specs.get(c, {}).get("kind") or "agent") in ACTION_CLASS_KINDS
            ]
            if action_pending:
                pending_set = set(action_pending)
                queue = [c for c in queue if c not in pending_set]
                action_outstanding = sum(
                    1
                    for c in outstanding
                    if (task_specs.get(c, {}).get("kind") or "agent") in ACTION_CLASS_KINDS
                )
                deferred_actions: list[str] = []
                for cid in action_pending:
                    if action_outstanding >= limits["maxConcurrentActions"]:
                        deferred_actions.append(cid)
                        continue
                    spec = task_specs[cid]
                    kind = str(spec.get("kind") or "agent")
                    spec["seq"] = seq_counter
                    seq_counter += 1
                    child_instance_id = script_child_instance_id(
                        ctx.instance_id, cid, spec.get("retries", 0)
                    )
                    spec["_instance_id"] = child_instance_id

                    child_task: Any
                    if dispatched_actions >= limits["maxLifetimeActions"]:
                        child_task = {
                            "dispatchError": (
                                f"action lifetime cap reached ({limits['maxLifetimeActions']}) "
                                "— raise DYNAMIC_SCRIPT_MAX_ACTION_CALLS or reduce "
                                "action()/sleep() calls"
                            )
                        }
                    elif kind == "sleep":
                        child_task = _start_sleep_timer(ctx, spec)
                    elif kind == "action":
                        child_task = start_action_call(
                            ctx,
                            call_id=cid,
                            spec=spec,
                            exec_id=exec_id,
                            workflow_id=workflow_id,
                            otel=otel,
                        )
                    else:  # kind == "event" — approve()/waitForEvent() gate child
                        child_task = start_event_wait_call(
                            ctx,
                            call_id=cid,
                            spec=spec,
                            exec_id=exec_id,
                            otel=otel,
                        )

                    if child_task is None or (
                        isinstance(child_task, dict) and child_task.get("dispatchError")
                    ):
                        raw = (
                            {"success": False, "error": str(child_task["dispatchError"])}
                            if isinstance(child_task, dict)
                            else {"success": False, "cancelled": True}
                        )
                        yield ctx.call_activity(
                            record_script_call_result,
                            input=_freeze(
                                {
                                    "executionId": exec_id,
                                    "callId": cid,
                                    "seq": spec["seq"],
                                    "spec": _spec_for_journal(spec),
                                    "raw": raw,
                                    "_otel": otel,
                                }
                            ),
                            retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                        )
                        resolved.add(cid)
                        resolved_at_dispatch += 1
                        continue

                    outstanding[cid] = child_task
                    dispatched_actions += 1
                    dispatched_this_round += 1
                    action_outstanding += 1
                    yield ctx.call_activity(
                        record_script_call_dispatch,
                        input=_freeze(
                            {
                                "executionId": exec_id,
                                "callId": cid,
                                "seq": spec["seq"],
                                "sessionId": None,
                                "spec": _spec_for_journal(spec),
                                "_otel": otel,
                            }
                        ),
                        retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                    )
                    yield ctx.call_activity(
                        update_execution_node,
                        input=_freeze(
                            {
                                "executionId": exec_id,
                                "nodeId": cid,
                                "nodeName": spec.get("label") or spec.get("actionSlug") or kind,
                                "_otel": otel,
                            }
                        ),
                        retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                    )
                # Over-cap action calls wait for the next dispatch round.
                queue = deferred_actions + queue
        if dispatch_mode == DISPATCH_MODE_BATCH_V2:
            batch: list[str] = []
            while queue and len(outstanding) + len(batch) < limits["maxConcurrentAgents"]:
                if dispatched + len(batch) >= limits["maxLifetimeAgents"]:
                    lifetime_exceeded = True
                    break
                batch.append(queue.pop(0))

            # Team ops bypass prepare_script_call entirely (no session
            # provisioning / runtime resolution): dispatch each as an un-awaited
            # activity Task (or the join child workflow) straight into
            # `outstanding` — activity Tasks multiplex through when_any exactly
            # like child-workflow Tasks.
            team_batch = [
                cid for cid in batch if (task_specs[cid].get("kind") or "agent") == "team"
            ]
            batch = [cid for cid in batch if cid not in set(team_batch)]
            for cid in team_batch:
                spec = task_specs[cid]
                child_instance_id = script_child_instance_id(
                    ctx.instance_id, cid, spec.get("retries", 0)
                )
                spec["_instance_id"] = child_instance_id
                spec["seq"] = seq_counter
                seq_counter += 1
                team_task = start_team_call(
                    ctx,
                    call_id=cid,
                    spec=spec,
                    exec_id=exec_id,
                    meta=meta,
                    otel=otel,
                )
                if isinstance(team_task, dict) and team_task.get("dispatchError"):
                    yield ctx.call_activity(
                        record_script_call_result,
                        input=_freeze(
                            {
                                "executionId": exec_id,
                                "callId": cid,
                                "seq": spec["seq"],
                                "spec": _spec_for_journal(spec),
                                "raw": {
                                    "success": False,
                                    "error": str(team_task["dispatchError"]),
                                },
                                "_otel": otel,
                            }
                        ),
                        retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                    )
                    resolved.add(cid)
                    resolved_at_dispatch += 1
                    continue
                team_used = True
                outstanding[cid] = team_task
                dispatched += 1
                dispatched_this_round += 1
                yield ctx.call_activity(
                    record_script_call_dispatch,
                    input=_freeze(
                        {
                            "executionId": exec_id,
                            "callId": cid,
                            "seq": spec["seq"],
                            "sessionId": None,  # no child session — a team op
                            "spec": _spec_for_journal(spec),
                            "_otel": otel,
                        }
                    ),
                    retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                )
                yield ctx.call_activity(
                    update_execution_node,
                    input=_freeze(
                        {
                            "executionId": exec_id,
                            "nodeId": cid,
                            "nodeName": spec.get("label") or f"team:{spec.get('teamOp') or 'op'}",
                            "_otel": otel,
                        }
                    ),
                    retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                )
                # No track_agent_run_scheduled: team ops are not agent runs.

            if batch:
                prepare_tasks = []
                for cid in batch:
                    spec = task_specs[cid]
                    child_instance_id = script_child_instance_id(
                        ctx.instance_id, cid, spec.get("retries", 0)
                    )
                    spec["_instance_id"] = child_instance_id
                    spec["seq"] = seq_counter
                    seq_counter += 1
                    prepare_tasks.append(
                        ctx.call_activity(
                            prepare_script_call,
                            input=_freeze(
                                {
                                    "parentInstanceId": ctx.instance_id,
                                    "executionId": exec_id,
                                    "callId": cid,
                                    "spec": spec,
                                    "meta": meta,
                                    "defaults": defaults,
                                    "limits": limits,
                                    "budgetTotal": budget_total,
                                    "workflowId": workflow_id,
                                    "userId": user_id,
                                    "projectId": project_id,
                                    "features": features,
                                    "_otel": otel,
                                }
                            ),
                            retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                        )
                    )

                prepared_results = yield wf_when_all(prepare_tasks)
                # Durable readiness barrier (concurrency plan P2): prepare no
                # longer blocks an activity thread waiting for queued hosts;
                # still-queued descriptors are re-polled here on durable
                # timers before dispatch (timeouts become per-call
                # dispatchError entries, not whole-run failures).
                prepared_results = yield from wait_for_prepared_agent_hosts(
                    ctx, prepared_results, _freeze, wf_when_all
                )
                for cid, prepared in zip(batch, prepared_results):
                    spec = task_specs[cid]
                    child_instance_id = str(spec.get("_instance_id") or "")
                    child_task = start_prepared_script_call(ctx, prepared)

                    if child_task is None or (
                        isinstance(child_task, dict) and child_task.get("dispatchError")
                    ):
                        # Bridge refused / dispatch failed -> journal immediately (no
                        # tracking). A dispatchError carries the reason so a failed
                        # workflow() call THROWS a meaningful message into the script;
                        # a plain None (bridge refusal / bad agentType) journals null.
                        if isinstance(child_task, dict):
                            raw = {"success": False, "error": str(child_task["dispatchError"])}
                        else:
                            raw = {"success": False, "cancelled": True}
                        yield ctx.call_activity(
                            record_script_call_result,
                            input=_freeze(
                                {
                                    "executionId": exec_id,
                                    "callId": cid,
                                    "seq": spec["seq"],
                                    "spec": _spec_for_journal(spec),
                                    "raw": raw,
                                    "_otel": otel,
                                }
                            ),
                            retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                        )
                        resolved.add(cid)
                        resolved_at_dispatch += 1
                        continue

                    outstanding[cid] = child_task
                    dispatched += 1
                    dispatched_this_round += 1

                    # Journal a non-terminal `running` row NOW so the run UI shows the
                    # in-flight call and (for agent() calls) can attach the child
                    # session's live transcript — the child instance id IS the session
                    # id and is deterministic at dispatch. workflow() children have no
                    # session (they are executions); their row still lights up the lane.
                    yield ctx.call_activity(
                        record_script_call_dispatch,
                        input=_freeze(
                            {
                                "executionId": exec_id,
                                "callId": cid,
                                "seq": spec["seq"],
                                "sessionId": (
                                    child_instance_id
                                    if (spec.get("kind") or "agent") == "agent"
                                    else None
                                ),
                                "spec": _spec_for_journal(spec),
                                "_otel": otel,
                            }
                        ),
                        retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                    )

                    # Keep workflow_executions.current_node_id fresh + light up the Agents tab.
                    yield ctx.call_activity(
                        update_execution_node,
                        input=_freeze(
                            {
                                "executionId": exec_id,
                                "nodeId": cid,
                                "nodeName": spec.get("label") or cid[:8],
                                "_otel": otel,
                            }
                        ),
                        retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                    )
                    yield ctx.call_activity(
                        track_agent_run_scheduled,
                        input=_freeze(
                            {
                                "id": child_instance_id,
                                "workflowExecutionId": exec_id,
                                "workflowId": workflow_id or "",
                                "nodeId": cid,
                                "mode": "run",
                                "agentWorkflowId": child_instance_id,
                                "daprInstanceId": child_instance_id,
                                "parentExecutionId": ctx.instance_id,
                                "_otel": otel,
                            }
                        ),
                        retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                    )
        else:
            while queue and len(outstanding) < limits["maxConcurrentAgents"]:
                if dispatched >= limits["maxLifetimeAgents"]:
                    lifetime_exceeded = True
                    break
                cid = queue.pop(0)
                spec = task_specs[cid]
                if (spec.get("kind") or "agent") == "team":
                    # Team ops skip session provisioning — dispatch directly.
                    child_task = start_team_call(
                        ctx,
                        call_id=cid,
                        spec=spec,
                        exec_id=exec_id,
                        meta=meta,
                        otel=otel,
                    )
                    if not (isinstance(child_task, dict) and child_task.get("dispatchError")):
                        team_used = True
                else:
                    child_task = yield from _start_script_call(
                        ctx,
                        call_id=cid,
                        spec=spec,
                        exec_id=exec_id,
                        meta=meta,
                        defaults=defaults,
                        limits=limits,
                        budget_total=budget_total,
                        workflow_id=workflow_id,
                        user_id=user_id,
                        project_id=project_id,
                        otel=otel,
                        features=features if actions_enabled else None,
                    )
                child_instance_id = script_child_instance_id(
                    ctx.instance_id, cid, spec.get("retries", 0)
                )
                spec["_instance_id"] = child_instance_id
                spec["seq"] = seq_counter
                seq_counter += 1

                if child_task is None or (
                    isinstance(child_task, dict) and child_task.get("dispatchError")
                ):
                    # Bridge refused / dispatch failed -> journal immediately (no
                    # tracking). A dispatchError carries the reason so a failed
                    # workflow() call THROWS a meaningful message into the script;
                    # a plain None (bridge refusal / bad agentType) journals null.
                    if isinstance(child_task, dict):
                        raw = {"success": False, "error": str(child_task["dispatchError"])}
                    else:
                        raw = {"success": False, "cancelled": True}
                    yield ctx.call_activity(
                        record_script_call_result,
                        input=_freeze(
                            {
                                "executionId": exec_id,
                                "callId": cid,
                                "seq": spec["seq"],
                                "spec": _spec_for_journal(spec),
                                "raw": raw,
                                "_otel": otel,
                            }
                        ),
                        retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                    )
                    resolved.add(cid)
                    resolved_at_dispatch += 1
                    continue

                outstanding[cid] = child_task
                dispatched += 1
                dispatched_this_round += 1

                # Journal a non-terminal `running` row NOW so the run UI shows the
                # in-flight call and (for agent() calls) can attach the child
                # session's live transcript — the child instance id IS the session
                # id and is deterministic at dispatch. workflow() children have no
                # session (they are executions); their row still lights up the lane.
                yield ctx.call_activity(
                    record_script_call_dispatch,
                    input=_freeze(
                        {
                            "executionId": exec_id,
                            "callId": cid,
                            "seq": spec["seq"],
                            "sessionId": (
                                child_instance_id
                                if (spec.get("kind") or "agent") == "agent"
                                else None
                            ),
                            "spec": _spec_for_journal(spec),
                            "_otel": otel,
                        }
                    ),
                    retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                )

                # Keep workflow_executions.current_node_id fresh + light up the Agents tab.
                yield ctx.call_activity(
                    update_execution_node,
                    input=_freeze(
                        {
                            "executionId": exec_id,
                            "nodeId": cid,
                            "nodeName": spec.get("label") or cid[:8],
                            "_otel": otel,
                        }
                    ),
                    retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                )
                if (spec.get("kind") or "agent") != "team":
                    # Team ops are not agent runs — no Agents-tab tracking row.
                    yield ctx.call_activity(
                        track_agent_run_scheduled,
                        input=_freeze(
                            {
                                "id": child_instance_id,
                                "workflowExecutionId": exec_id,
                                "workflowId": workflow_id or "",
                                "nodeId": cid,
                                "mode": "run",
                                "agentWorkflowId": child_instance_id,
                                "daprInstanceId": child_instance_id,
                                "parentExecutionId": ctx.instance_id,
                                "_otel": otel,
                            }
                        ),
                        retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                    )

        _set_status(current_phase or "running", budget)

        # No in-flight children: either the lifetime cap stalled dispatch (the
        # evaluator will synthesize throws next round), or calls resolved
        # SYNCHRONOUSLY at dispatch (dispatchError / bridge refusal journaled a
        # terminal row the next evaluate observes — e.g. a workflow() call with
        # an unknown ref whose throw the script catches), or a genuine
        # no-progress stall.
        if not outstanding:
            if (
                lifetime_exceeded
                or dispatched_this_round
                or resolved_at_dispatch
                or skew_resolved_this_round
            ):
                continue
            yield from _team_auto_shutdown(ctx, exec_id, team_used and not nested, otel)
            if not nested:
                yield ctx.call_activity(
                    persist_results_to_db,
                    input=_freeze(
                        {
                            "executionId": ctx.instance_id,
                            "dbExecutionId": exec_id,
                            "success": False,
                            "error": "evaluator returned 'need' with no dispatchable work",
                            "phase": current_phase or "failed",
                            "_otel": otel,
                        }
                    ),
                    retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                )
            return {
                "success": False,
                "status": "script_error",
                "error": "evaluator returned 'need' with no dispatchable work",
                "dispatched": dispatched,
                "logCount": seen_log_count,
            }

        # 5. Wait: [cancel, control, *outstanding] (never empty — cancel/control present).
        wait_set = [cancel_task, control_task, *outstanding.values()]
        winner = yield wf_when_any(wait_set)

        if winner is cancel_task:
            get_result = getattr(cancel_task, "get_result", None)
            event = get_result() if callable(get_result) else {}
            event = event if isinstance(event, dict) else {}
            reason = event.get("reason") or "workflow cancelled"
            _set_status("cancelled", budget)
            yield from _team_auto_shutdown(ctx, exec_id, team_used and not nested, otel)
            if not nested:
                yield ctx.call_activity(
                    persist_results_to_db,
                    input=_freeze(
                        {
                            "executionId": ctx.instance_id,
                            "dbExecutionId": exec_id,
                            "success": False,
                            "error": str(reason),
                            "phase": "cancelled",
                            "_otel": otel,
                        }
                    ),
                    retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                )
            return {
                "success": False,
                "status": "cancelled",
                "cancelled": True,
                "error": str(reason),
                "dispatched": dispatched,
                "logCount": seen_log_count,
            }

        if winner is control_task:
            get_result = getattr(control_task, "get_result", None)
            event = get_result() if callable(get_result) else {}
            event = event if isinstance(event, dict) else {}
            # Re-create the control task for subsequent events.
            control_task = ctx.wait_for_external_event(CONTROL_EVENT_NAME)
            action = str(event.get("action") or "").strip().lower()
            target_call = str(event.get("callId") or "").strip()
            if action == "skip" and target_call:
                if target_call in outstanding:
                    if dispatch_mode == DISPATCH_MODE_BATCH_V2:
                        spec = task_specs.get(target_call) or {}
                        child_instance_id = str(spec.get("_instance_id") or "")
                        if (spec.get("kind") or "agent") == "agent" and child_instance_id:
                            yield ctx.call_activity(
                                request_session_stop,
                                input=_freeze(
                                    {
                                        "sessionId": child_instance_id,
                                        "userId": user_id,
                                        "projectId": project_id,
                                        "mode": "terminate",
                                        "reason": f"dynamic-script call {target_call} skipped",
                                        "_otel": otel,
                                    }
                                ),
                                retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                            )
                    # Stop tracking; do NOT await the child result after skip.
                    del outstanding[target_call]
                    yield from _journal_skip(ctx, exec_id, target_call, task_specs, otel)
                    resolved.add(target_call)
                elif target_call in queue:
                    queue.remove(target_call)
                    yield from _journal_skip(ctx, exec_id, target_call, task_specs, otel)
                    resolved.add(target_call)
            continue

        # 6. Drain ALL completed children (validated SDK semantics: events processed
        #    one-at-a-time in persisted order — replay-deterministic).
        drained_done = 0
        for cid, task in list(outstanding.items()):
            if not _task_is_complete(task):
                continue
            try:
                raw = task.get_result()
            except Exception as exc:  # noqa: BLE001 — child failure -> null
                raw = {"success": False, "error": str(exc)}
            del outstanding[cid]
            spec = task_specs.get(cid) or {}
            if (spec.get("kind") or "agent") == "sleep" and raw is None:
                # Timer Tasks complete with None — synthesize the journal envelope.
                raw = {"success": True, "sleptSeconds": spec.get("seconds")}
            rec = yield ctx.call_activity(
                record_script_call_result,
                input=_freeze(
                    {
                        "executionId": exec_id,
                        "callId": cid,
                        "seq": spec.get("seq", 0),
                        "spec": _spec_for_journal(spec),
                        "raw": raw if isinstance(raw, dict) else {"content": str(raw)},
                        "_otel": otel,
                    }
                ),
                retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
            )
            rec = rec if isinstance(rec, dict) else {}
            rec_status = rec.get("status")
            run_id = spec.get("_instance_id")
            if rec_status == "retry_structured":
                spec["retries"] = _as_int(spec.get("retries"), 0) + 1
                spec["feedback"] = rec.get("feedback")
                task_specs[cid] = spec
                queue.insert(0, cid)  # re-queue at FRONT (corrective session)
            else:
                resolved.add(cid)
                drained_done += 1
            if run_id and (spec.get("kind") or "agent") not in ({"team"} | ACTION_CLASS_KINDS):
                yield ctx.call_activity(
                    track_agent_run_completed,
                    input=_freeze(
                        {
                            "id": run_id,
                            "success": rec_status in {"done"},
                            "result": raw if isinstance(raw, dict) else {"content": str(raw)},
                            "error": rec.get("errorCode"),
                            "_otel": otel,
                        }
                    ),
                    retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
                )

        # Usage-settle gate: agent.llm_usage events are ingested asynchronously
        # (runtime → CMA ingest → session_events), so a fast child can complete
        # BEFORE its tokens are queryable — the next aggregate would read a
        # stale sum and under-enforce the budget (observed on dev: a fast GLM
        # first call let a 50-token budget dispatch its second call). When the
        # run is budget-bounded and this round resolved ≥1 call, park on a
        # deterministic timer so the aggregate sees the settled usage.
        if budget_total is not None and drained_done > 0:
            yield ctx.create_timer(timedelta(seconds=USAGE_SETTLE_SECONDS))
        # loop


def _start_sleep_timer(ctx, spec: dict[str, Any]):
    """An un-awaited durable-timer Task for a sleep() call — multiplexes through
    the pump's when_any exactly like child/activity Tasks (SW precedent: the
    dev-preview deadline race composes timers in when_any). Clamped to
    MAX_SLEEP_SECONDS; a stopped+resumed run restarts pending sleeps at full
    duration (only `done` journal rows import)."""
    try:
        seconds = float(spec.get("seconds"))
    except (TypeError, ValueError):
        return {"dispatchError": "sleep(): seconds must be a number"}
    if seconds < 0:
        return {"dispatchError": "sleep(): seconds must be >= 0"}
    return ctx.create_timer(timedelta(seconds=min(seconds, float(MAX_SLEEP_SECONDS))))


def _team_call_label(op: Any, args: Any) -> str:
    """Human label for a team op, shown in the run rail + Agents lane. Pure
    (deterministic) so it is safe at workflow-replay time."""
    op = str(op or "op")
    a = args if isinstance(args, dict) else {}
    if op == "spawn":
        who = str(a.get("name") or a.get("agent") or "").strip()
        return f"spawn {who}".strip()
    if op == "task":
        title = str(a.get("title") or "").strip()
        return f'task "{title[:24]}"' if title else "task"
    if op == "send":
        return f"send \u2192 {a.get('to') or '?'}"
    if op == "broadcast":
        return "broadcast"
    if op == "join":
        return f"join ({a.get('until') or 'tasks-complete'})"
    if op == "shutdown":
        return f"shutdown {a.get('name') or 'all'}"
    return op


def _spec_for_journal(spec: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": spec.get("kind") or "agent",
        "teamOp": spec.get("teamOp"),
        "label": spec.get("label"),
        "phase": spec.get("phase"),
        "promptSha256": spec.get("promptSha256"),
        "baseHash": spec.get("baseHash"),
        "occurrence": spec.get("occurrence"),
        "schema": spec.get("schema"),
        "retries": _as_int(spec.get("retries"), 0),
        "maxStructuredRetries": _as_int(spec.get("maxStructuredRetries"), DEFAULT_MAX_STRUCTURED_RETRIES),
        # Contract-1.2.0 action-class carriers (None for other kinds); the
        # journal's kind branches read actionSlug/actionOpts.allowFailure and
        # seconds for the terminal-row decision.
        "actionSlug": spec.get("actionSlug"),
        "actionOpts": spec.get("actionOpts"),
        "seconds": spec.get("seconds"),
        "eventName": spec.get("eventName"),
    }


def _team_auto_shutdown(ctx, exec_id: str, team_used: bool, otel):
    """Terminal cleanup for script-led teams: shut every teammate down so they
    never outlive the run (suspend/sweeper ticks are only a cost backstop).
    Best-effort — a shutdown failure must not mask the run's own outcome."""
    if not team_used:
        return
    try:
        yield ctx.call_activity(
            execute_team_op,
            input=_freeze(
                {"executionId": exec_id, "op": "shutdown", "args": {}, "_otel": otel}
            ),
            retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
        )
    except Exception:  # noqa: BLE001
        logger.warning("[dynamic-script] team auto-shutdown failed for %s", exec_id)


def _journal_skip(ctx, exec_id, call_id, task_specs, otel):
    spec = task_specs.get(call_id) or {}
    yield ctx.call_activity(
        record_script_call_result,
        input=_freeze(
            {
                "executionId": exec_id,
                "callId": call_id,
                "seq": spec.get("seq", 0),
                "spec": _spec_for_journal(spec),
                "raw": {"skipped": True},
                "_otel": otel,
            }
        ),
        retry_policy=_BFF_ACTIVITY_RETRY_POLICY,
    )


def _task_is_complete(task: Any) -> bool:
    value = getattr(task, "is_complete", False)
    if callable(value):
        try:
            return bool(value())
        except Exception:
            return False
    return bool(value)
