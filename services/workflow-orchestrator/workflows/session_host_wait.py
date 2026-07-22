"""Durable-timer readiness wait for per-session agent workflow hosts.

Concurrency plan P2: replaces the in-activity ``time.sleep`` readiness loop
that pinned one runtime thread-pool worker per in-flight spawn (fleet cap =
replicas x DAPR_WORKFLOW_MAX_THREAD_POOL_WORKERS, with head-of-line blocking
of every other activity during Kueue admission waves). The wait now lives in
workflow history as the standard eternal-poll pattern: re-invoke the
idempotent ``spawn_session_for_workflow`` activity (a single ensure POST that
returns current host status), sleep on a durable ``ctx.create_timer`` between
polls, and give up after a replay-stable budget of recorded durable timers.
Timers ride the HA scheduler service instead of orchestrator threads, so
hundreds of spawns can be pending per replica.

Both helpers are generators for use via ``yield from`` inside workflow code.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from activities.spawn_session import (
    DEFAULT_AGENT_SESSION_HOST_READY_POLL_SECONDS,
    DEFAULT_AGENT_SESSION_HOST_READY_TIMEOUT_SECONDS,
    _agent_session_host_status,
    _int_env,
    agent_session_host_wait_needed,
    spawn_session_for_workflow,
)


_REPLAY_STABLE_HOST_WAIT_BUDGET_PATCH = "agent-host-wait-budget-v1"
_HOST_WAIT_BUDGET_V1_POLL_SECONDS = 5
_HOST_WAIT_BUDGET_V1_TIMEOUT_SECONDS = 900


def _uses_replay_stable_wait_budget(ctx) -> bool:
    """Keep existing histories on their recorded action sequence.

    Dapr's workflow clock is the timestamp of the current orchestration work
    item. Recomputing an absolute deadline from it on every replay slides that
    deadline forward. Fresh workflows instead bound the number of durable poll
    timers; replay consumes the same recorded timers and therefore reconstructs
    the same remaining budget without consulting the moving work-item clock.
    """
    is_patched = getattr(ctx, "is_patched", None)
    return (
        bool(is_patched(_REPLAY_STABLE_HOST_WAIT_BUDGET_PATCH))
        if callable(is_patched)
        else True
    )


def _host_wait_poll_budget(poll_seconds: int, timeout_seconds: int) -> int:
    return max(0, timeout_seconds // poll_seconds)


def _legacy_poll_and_timeout_seconds() -> tuple[int, int]:
    """Read the legacy environment-controlled timing contract.

    Fresh v1 histories use constants below because changing pod environment
    between replays must not change the number or duration of recorded actions.
    A future timing change requires a new workflow patch version.
    """
    poll_seconds = _int_env(
        "AGENT_SESSION_HOST_READY_POLL_SECONDS",
        DEFAULT_AGENT_SESSION_HOST_READY_POLL_SECONDS,
    )
    timeout_seconds = _int_env(
        "AGENT_SESSION_HOST_READY_TIMEOUT_SECONDS",
        DEFAULT_AGENT_SESSION_HOST_READY_TIMEOUT_SECONDS,
    )
    return poll_seconds, timeout_seconds


def _poll_and_timeout_seconds(*, replay_stable_budget: bool) -> tuple[int, int]:
    if replay_stable_budget:
        return (
            _HOST_WAIT_BUDGET_V1_POLL_SECONDS,
            _HOST_WAIT_BUDGET_V1_TIMEOUT_SECONDS,
        )
    return _legacy_poll_and_timeout_seconds()


def spawn_session_with_host_wait(ctx, bridge_payload: dict[str, Any], freeze):
    """Ensure a session row + wait durably for its agent host to become ready.

    Generator (``yield from`` in workflow code). Returns the final bridge
    result exactly as the old blocking activity did: immediately for
    cancelled / non-host / already-ready results, otherwise after the BFF
    reports the per-session host ready. Raises ``TimeoutError`` past
    AGENT_SESSION_HOST_READY_TIMEOUT_SECONDS, preserving the old failure mode
    at the same call-site altitude.
    """
    replay_stable_budget = _uses_replay_stable_wait_budget(ctx)
    poll_seconds, timeout_seconds = _poll_and_timeout_seconds(
        replay_stable_budget=replay_stable_budget
    )
    polls_remaining = _host_wait_poll_budget(poll_seconds, timeout_seconds)
    deadline = (
        None
        if replay_stable_budget
        else ctx.current_utc_datetime + timedelta(seconds=timeout_seconds)
    )
    while True:
        result = yield ctx.call_activity(
            spawn_session_for_workflow, input=freeze(bridge_payload)
        )
        if not agent_session_host_wait_needed(
            result, missing_status_waits=replay_stable_budget
        ):
            return result
        if replay_stable_budget:
            timed_out = polls_remaining <= 0
        else:
            assert deadline is not None
            timed_out = (
                ctx.current_utc_datetime + timedelta(seconds=poll_seconds) > deadline
            )
        if timed_out:
            raise TimeoutError(
                f"agent workflow host {result.get('agentAppId')} did not become "
                "ready before scheduling session_workflow; last status="
                f"{_agent_session_host_status(result)}"
            )
        if replay_stable_budget:
            polls_remaining -= 1
            yield ctx.create_timer(timedelta(seconds=poll_seconds))
        else:
            yield ctx.create_timer(
                ctx.current_utc_datetime + timedelta(seconds=poll_seconds)
            )


def wait_for_prepared_agent_hosts(
    ctx,
    prepared_results: list[Any],
    freeze,
    when_all,
):
    """Durable readiness barrier for a batch of ``prepare_script_call`` results.

    Generator (``yield from`` in the dynamic-script pump). Each agent
    descriptor carries the ``bridgePayload`` it was provisioned with plus the
    BFF's last reported ``agentHostStatus``; descriptors whose host is still
    queued are re-polled together on one durable timer tick (one
    ``spawn_session_for_workflow`` activity per pending descriptor, joined via
    ``when_all``). Hosts that never become ready are converted to per-call
    ``dispatchError`` descriptors — the pump journals those as individual call
    failures instead of failing the whole script run, mirroring how it already
    treats bridge refusals.
    """
    replay_stable_budget = _uses_replay_stable_wait_budget(ctx)
    poll_seconds, timeout_seconds = _poll_and_timeout_seconds(
        replay_stable_budget=replay_stable_budget
    )
    polls_remaining = _host_wait_poll_budget(poll_seconds, timeout_seconds)
    deadline = (
        None
        if replay_stable_budget
        else ctx.current_utc_datetime + timedelta(seconds=timeout_seconds)
    )
    results = list(prepared_results)

    def _pending_indexes() -> list[int]:
        pending: list[int] = []
        for index, prepared in enumerate(results):
            if not isinstance(prepared, dict) or prepared.get("kind") != "agent":
                continue
            if not isinstance(prepared.get("bridgePayload"), dict):
                continue
            probe = {
                "agentAppId": prepared.get("appId"),
                "agentHostStatus": prepared.get("agentHostStatus"),
            }
            if agent_session_host_wait_needed(
                probe, missing_status_waits=replay_stable_budget
            ):
                pending.append(index)
        return pending

    while True:
        pending = _pending_indexes()
        if not pending:
            return results
        if replay_stable_budget:
            timed_out = polls_remaining <= 0
        else:
            assert deadline is not None
            timed_out = (
                ctx.current_utc_datetime + timedelta(seconds=poll_seconds) > deadline
            )
        if timed_out:
            for index in pending:
                prepared = results[index]
                results[index] = {
                    "kind": "dispatchError",
                    "callId": prepared.get("callId"),
                    "childInstanceId": prepared.get("childInstanceId"),
                    "dispatchError": (
                        f"agent workflow host {prepared.get('appId')} did not "
                        f"become ready within {timeout_seconds}s; last status="
                        f"{prepared.get('agentHostStatus')}"
                    ),
                }
            return results
        if replay_stable_budget:
            polls_remaining -= 1
            yield ctx.create_timer(timedelta(seconds=poll_seconds))
        else:
            yield ctx.create_timer(
                ctx.current_utc_datetime + timedelta(seconds=poll_seconds)
            )
        checks = yield when_all(
            [
                ctx.call_activity(
                    spawn_session_for_workflow,
                    input=freeze(results[index]["bridgePayload"]),
                )
                for index in pending
            ]
        )
        for index, body in zip(pending, checks):
            if not isinstance(body, dict):
                continue
            prepared = results[index]
            updated = {
                **prepared,
                "agentHostStatus": body.get("agentHostStatus")
                or body.get("status")
                or prepared.get("agentHostStatus"),
            }
            returned_app_id = body.get("agentAppId")
            if isinstance(returned_app_id, str) and returned_app_id.strip():
                updated["appId"] = returned_app_id.strip()
            # Re-polls can surface childInput fields that only exist once the
            # host finished provisioning (e.g. runtimeSandboxName). Take the
            # fresh bridge childInput and re-apply the pump's overlay keys the
            # same way prepare_script_call merged them.
            fresh_child_input = body.get("childInput")
            prepared_child_input = prepared.get("childInput")
            if isinstance(fresh_child_input, dict) and isinstance(
                prepared_child_input, dict
            ):
                overlay_keys = (
                    "workflowId",
                    "workflowExecutionId",
                    "dbExecutionId",
                    "nodeId",
                    "nodeName",
                    "_otel",
                )
                merged = {
                    **fresh_child_input,
                    **{
                        key: prepared_child_input[key]
                        for key in overlay_keys
                        if key in prepared_child_input
                    },
                }
                merged["agentId"] = body.get("agentId") or prepared_child_input.get(
                    "agentId"
                )
                merged["agentAppId"] = updated.get("appId") or prepared_child_input.get(
                    "agentAppId"
                )
                updated["childInput"] = merged
            if body.get("cancelled") is True:
                updated = {
                    "kind": "null",
                    "callId": prepared.get("callId"),
                    "childInstanceId": prepared.get("childInstanceId"),
                    "reason": body.get("error") or "session bridge refused",
                }
            results[index] = updated
