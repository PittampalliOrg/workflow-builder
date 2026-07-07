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
from dapr.ext.workflow import when_any as wf_when_any

from activities.aggregate_script_usage import aggregate_script_usage
from activities.evaluate_script import evaluate_script
from activities.append_script_logs import append_script_logs
from activities.persist_results_to_db import persist_results_to_db
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
from workflows.script_agent_dispatch import _start_script_call, script_child_instance_id
from workflows.sw_workflow import _freeze

logger = logging.getLogger(__name__)

DYNAMIC_SCRIPT_WORKFLOW_NAME = "dynamic_script_workflow_v1"

CANCEL_EVENT_NAME = "workflow.cancel"
CONTROL_EVENT_NAME = "script.call.control"

# Politeness caps (above Kueue admission). Input limits are clamped by env.
DEFAULT_MAX_CONCURRENCY = int(os.environ.get("DYNAMIC_SCRIPT_MAX_CONCURRENCY", "5") or "5")
DEFAULT_MAX_AGENT_CALLS = int(os.environ.get("DYNAMIC_SCRIPT_MAX_AGENT_CALLS", "50") or "50")
DEFAULT_MAX_LIFETIME_AGENTS = 1000
DEFAULT_MAX_STRUCTURED_RETRIES = 5
# Post-drain settle delay before the next budget aggregate (see the
# usage-settle gate in the pump loop). Only applies to budget-bounded runs.
USAGE_SETTLE_SECONDS = int(os.environ.get("DYNAMIC_SCRIPT_USAGE_SETTLE_SECONDS", "3") or "3")

# Retry policy for the evaluate_script activity (cloned from sw_workflow._AP_RETRY_POLICY):
# transport / 5xx failures RAISE and are retried; 4xx are returned as script_error
# (non-retryable) by the activity itself.
_SCRIPT_EVAL_RETRY_POLICY = wf.RetryPolicy(
    first_retry_interval=timedelta(
        seconds=int(os.environ.get("SCRIPT_EVAL_RETRY_FIRST_INTERVAL_SECONDS", "2"))
    ),
    max_number_of_attempts=int(os.environ.get("SCRIPT_EVAL_RETRY_MAX_ATTEMPTS", "5")),
    backoff_coefficient=float(os.environ.get("SCRIPT_EVAL_RETRY_BACKOFF_COEFFICIENT", "2")),
    max_retry_interval=timedelta(
        seconds=int(os.environ.get("SCRIPT_EVAL_RETRY_MAX_INTERVAL_SECONDS", "60"))
    ),
)


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
    return {
        "maxConcurrentAgents": max_concurrent,
        "maxLifetimeAgents": max_lifetime,
        "maxItemsPerCall": _as_int(input_limits.get("maxItemsPerCall"), 4096),
        "maxStructuredRetries": max_structured,
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
        )

    # ---- pump state (all deterministic) ------------------------------------
    queue: list[str] = []            # callIds pending dispatch (insertion order)
    outstanding: dict[str, Any] = {}  # callId -> in-flight child Task (insertion-ordered)
    task_specs: dict[str, dict[str, Any]] = {}  # callId -> spec (kind/opts/retries/feedback/...)
    resolved: set[str] = set()        # terminally journaled callIds
    seen_log_count = 0
    dispatched = 0
    seq_counter = 0
    lifetime_exceeded = False
    last_status_json: str | None = None
    current_phase = ""
    declared_phases: list[str] = []

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
        # 1. Budget (skip aggregation when unbounded).
        if budget_total is not None:
            usage = yield ctx.call_activity(
                aggregate_script_usage,
                input=_freeze({"executionId": exec_id, "_otel": otel}),
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
                }
            )
            # workflow() child args: VERBATIM any-JSON value; key-absence means
            # the parent passed nothing (child's `args` global -> undefined).
            if "args" in task:
                spec["args"] = task.get("args")
            opts = spec["opts"]
            spec["label"] = opts.get("label")
            spec["phase"] = opts.get("phase")
            spec["schema"] = opts.get("schema") if isinstance(opts.get("schema"), dict) else None
            spec["promptSha256"] = hashlib.sha256(
                str(spec.get("prompt") or "").encode("utf-8")
            ).hexdigest()
            spec["maxStructuredRetries"] = limits["maxStructuredRetries"]
            spec.setdefault("retries", 0)
            task_specs[cid] = spec
            queue.append(cid)

        # 4. Dispatch under caps.
        dispatched_this_round = 0
        resolved_at_dispatch = 0  # calls journaled terminal AT dispatch (no child)
        while queue and len(outstanding) < limits["maxConcurrentAgents"]:
            if dispatched >= limits["maxLifetimeAgents"]:
                lifetime_exceeded = True
                break
            cid = queue.pop(0)
            spec = task_specs[cid]
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
            )

        _set_status(current_phase or "running", budget)

        # No in-flight children: either the lifetime cap stalled dispatch (the
        # evaluator will synthesize throws next round), or calls resolved
        # SYNCHRONOUSLY at dispatch (dispatchError / bridge refusal journaled a
        # terminal row the next evaluate observes — e.g. a workflow() call with
        # an unknown ref whose throw the script catches), or a genuine
        # no-progress stall.
        if not outstanding:
            if lifetime_exceeded or dispatched_this_round or resolved_at_dispatch:
                continue
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
                    # Stop tracking; do NOT await the child (v1: it self-reaps).
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
            if run_id:
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


def _spec_for_journal(spec: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": spec.get("kind") or "agent",
        "label": spec.get("label"),
        "phase": spec.get("phase"),
        "promptSha256": spec.get("promptSha256"),
        "baseHash": spec.get("baseHash"),
        "occurrence": spec.get("occurrence"),
        "schema": spec.get("schema"),
        "retries": _as_int(spec.get("retries"), 0),
        "maxStructuredRetries": _as_int(spec.get("maxStructuredRetries"), DEFAULT_MAX_STRUCTURED_RETRIES),
    }


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
    )


def _task_is_complete(task: Any) -> bool:
    value = getattr(task, "is_complete", False)
    if callable(value):
        try:
            return bool(value())
        except Exception:
            return False
    return bool(value)
