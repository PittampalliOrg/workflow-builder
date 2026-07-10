"""``team_join_workflow_v1`` — the awaitable behind the script `team.join()`.

A tiny deterministic child workflow: poll the team view (``get_team_state``
activity) → check the predicate → ``ctx.create_timer(poll)`` → repeat, until the
predicate holds or the timeout elapses. Runs as a CHILD of the dynamic-script
pump so all timer-replay volume stays in this child's own (small) history; the
pump sees a single completion through its existing ``when_any`` wait-set, then
journals the result once — exactly the agent() child pattern.

Predicates (evaluated on the BFF team view {members, tasks}):
  • ``tasks-complete`` (default): tasks list non-empty AND every task completed.
  • ``all-idle``: member-role members non-empty AND every one of them in
    {idle, suspended, shutdown, failed} (i.e. nobody actively working).

Timeout RESOLVES (never throws): the script receives the final snapshot with
``timedOut: true`` and decides what to do — mirroring how a human lead would
just look at the clock. Poll interval floors at 15s so ≤480 timers at the
120-minute cap.
"""

from __future__ import annotations

import logging
import os
from datetime import timedelta
from typing import Any

import dapr.ext.workflow as wf

from activities.team_ops import get_team_state

logger = logging.getLogger(__name__)

TEAM_JOIN_WORKFLOW_NAME = "team_join_workflow_v1"

_MIN_POLL_SECONDS = 15
_DEFAULT_TIMEOUT_MINUTES = 30
_MAX_TIMEOUT_MINUTES = 120

# Terminal-ish member states for the all-idle predicate: nobody is actively
# driving a turn. `suspended` counts — a hibernated teammate is not working.
_QUIESCENT_MEMBER_STATUSES = {"idle", "suspended", "shutdown", "failed"}


def _poll_seconds() -> int:
    try:
        raw = int(os.environ.get("DYNAMIC_SCRIPT_TEAM_JOIN_POLL_SECONDS", "15"))
    except ValueError:
        raw = 15
    return max(_MIN_POLL_SECONDS, raw)


def _predicate_satisfied(until: str, view: dict[str, Any]) -> bool:
    tasks = view.get("tasks") if isinstance(view.get("tasks"), list) else []
    members = view.get("members") if isinstance(view.get("members"), list) else []
    if until == "all-idle":
        workers = [m for m in members if isinstance(m, dict) and m.get("role") != "lead"]
        return bool(workers) and all(
            str(m.get("status") or "") in _QUIESCENT_MEMBER_STATUSES for m in workers
        )
    # default: tasks-complete
    return bool(tasks) and all(
        isinstance(t, dict) and t.get("status") == "completed" for t in tasks
    )


def team_join_workflow(ctx: wf.DaprWorkflowContext, input_data: dict):
    """Input: {executionId, until?, timeoutMinutes?}. Returns
    {"success": True, "result": {...view, until, satisfied, timedOut, polls}}
    — or {"success": False, "error"} only when the team API deterministically
    rejects (e.g. project-less execution)."""
    execution_id = str(input_data.get("executionId") or "").strip()
    until = str(input_data.get("until") or "tasks-complete").strip() or "tasks-complete"
    if until not in ("tasks-complete", "all-idle"):
        return {"success": False, "error": f"unknown join predicate '{until}'"}
    try:
        timeout_minutes = float(input_data.get("timeoutMinutes") or _DEFAULT_TIMEOUT_MINUTES)
    except (TypeError, ValueError):
        timeout_minutes = float(_DEFAULT_TIMEOUT_MINUTES)
    timeout_minutes = min(max(timeout_minutes, 1.0), float(_MAX_TIMEOUT_MINUTES))

    poll = _poll_seconds()
    max_polls = max(1, int((timeout_minutes * 60) // poll))
    otel = input_data.get("_otel")

    last_view: dict[str, Any] = {}
    polls = 0
    for _ in range(max_polls):
        polls += 1
        state = yield ctx.call_activity(
            get_team_state,
            input={"executionId": execution_id, "_otel": otel},
        )
        if not isinstance(state, dict) or not state.get("success"):
            error = (state or {}).get("error") if isinstance(state, dict) else None
            return {"success": False, "error": str(error or "get_team_state failed")}
        view = state.get("result") if isinstance(state.get("result"), dict) else {}
        last_view = view
        if _predicate_satisfied(until, view):
            return {
                "success": True,
                "result": {
                    **view,
                    "until": until,
                    "satisfied": True,
                    "timedOut": False,
                    "polls": polls,
                },
            }
        yield ctx.create_timer(timedelta(seconds=poll))

    return {
        "success": True,
        "result": {
            **last_view,
            "until": until,
            "satisfied": False,
            "timedOut": True,
            "polls": polls,
        },
    }
