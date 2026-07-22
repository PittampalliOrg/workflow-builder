"""Agent Teams operations for SCRIPT-LED teams ("the script is the lead").

The dynamic-script `team.*` primitives dispatch here. Every op first ensures the
script team exists (idempotent — POST /api/internal/team/ensure-script-team
derives teamId=`team-<executionId>` and the lead anchor session), then forwards
to the matching BFF internal team endpoint. Team calls use the workflow-builder
Service directly: unlike short workflow-data requests, teammate spawn can wait
for sandbox and runtime provisioning and must not inherit the app-wide Dapr
service-invocation deadline. Authentication remains ``X-Internal-Token`` plus
the server-derived system principal.

Error contract (consumed by workflows/dynamic_script_workflow.py's journal +
the evaluator's team-call resolution):
  • 4xx from the BFF  -> return {"success": False, "error": "<msg>"} — journals
    as an `error` row, THROWN into the script (catchable). Deterministic
    failures (unknown agent slug, unknown teammate name, no project) must NOT
    retry.
  • transport / 5xx   -> raise — the activity retry policy retries.
  • shutdown 202 or a partial 2xx -> raise — accepted is not terminal; retry
    until the BFF confirms the durable run closed.
"""

from __future__ import annotations

import os
import time
from contextvars import ContextVar
from functools import wraps
from typing import Any
from urllib.parse import quote

import requests


class TeamOpsApiError(RuntimeError):
    """Transport-level failure talking to the BFF team API (retriable)."""


_TEAM_API_MAX_REQUEST_TIMEOUT_SECONDS = 30.0
_TEAM_OP_ATTEMPT_HTTP_BUDGET_SECONDS = 60.0
_team_op_attempt_deadline: ContextVar[float | None] = ContextVar(
    "team_op_attempt_deadline",
    default=None,
)


def _timeout_seconds() -> float:
    # Retry lifecycle convergence durably instead of holding an orchestrator
    # worker on one request. The env knob may shorten, but never extend, this
    # deadline because it is part of the activity's tested wall-time budget.
    try:
        configured = float(os.environ.get("TEAM_API_TIMEOUT_SECONDS", "30"))
    except ValueError:
        configured = _TEAM_API_MAX_REQUEST_TIMEOUT_SECONDS
    timeout = min(
        max(0.1, configured),
        _TEAM_API_MAX_REQUEST_TIMEOUT_SECONDS,
    )
    deadline = _team_op_attempt_deadline.get()
    if deadline is None:
        return timeout
    remaining = deadline - time.monotonic()
    if remaining < 0.1:
        raise TeamOpsApiError("team API activity attempt HTTP budget exhausted")
    return min(timeout, remaining)


def _bounded_http_attempt(fn):
    """Cap all HTTP calls made by one activity attempt, including shutdown-all."""

    @wraps(fn)
    def bounded(*args, **kwargs):
        token = _team_op_attempt_deadline.set(
            time.monotonic() + _TEAM_OP_ATTEMPT_HTTP_BUDGET_SECONDS
        )
        try:
            return fn(*args, **kwargs)
        finally:
            _team_op_attempt_deadline.reset(token)

    return bounded


def _direct_base_url() -> str:
    return os.environ.get(
        "WORKFLOW_BUILDER_URL",
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
    ).rstrip("/")


def _base_url() -> str:
    return _direct_base_url()


def _request(
    method: str,
    path: str,
    json_body: dict[str, Any] | None = None,
    *,
    acting_session_id: str | None = None,
) -> tuple[int, Any]:
    """One HTTP call. Returns (status, parsed-json-or-text). Raises on transport."""
    token = os.environ.get("INTERNAL_API_TOKEN", "").strip()
    if not token:
        raise TeamOpsApiError("INTERNAL_API_TOKEN is required for the team API")
    url = f"{_base_url()}/{path.lstrip('/')}"
    headers = {
        "Content-Type": "application/json",
        "X-Internal-Token": token,
        "X-Wfb-System-Principal": "workflow-orchestrator-team-script",
    }
    if acting_session_id:
        headers["X-Wfb-Session-Id"] = acting_session_id
    try:
        response = requests.request(
            method,
            url,
            headers=headers,
            json=json_body,
            timeout=_timeout_seconds(),
        )
    except requests.RequestException as exc:  # transport → retriable
        raise TeamOpsApiError(f"team API {method} {path} transport failure: {exc}") from exc
    if response.status_code >= 500:
        raise TeamOpsApiError(
            f"team API {method} {path} failed ({response.status_code}): {response.text[:300]}"
        )
    try:
        body: Any = response.json()
    except ValueError:
        body = response.text
    return response.status_code, body


def _client_error_message(status: int, body: Any) -> str:
    if isinstance(body, dict):
        msg = body.get("message") or body.get("error")
        if isinstance(msg, str) and msg.strip():
            return msg.strip()
    if isinstance(body, str) and body.strip():
        return body.strip()[:300]
    return f"team API returned HTTP {status}"


def _shutdown_confirmed(status: int, body: Any) -> bool:
    """Require positive, internally consistent terminal evidence."""
    if (
        not 200 <= status < 300
        or not isinstance(body, dict)
        or body.get("ok") is not True
    ):
        return False
    top_state = body.get("state")
    top_confirmed = top_state == "confirmed"
    if top_state is not None and not top_confirmed:
        return False

    nested_present = "stop" in body
    stop = body.get("stop")
    nested_confirmed = (
        isinstance(stop, dict)
        and stop.get("confirmed") is True
        and stop.get("state") == "confirmed"
    )
    # A present nested lifecycle result is part of the evidence contract. It
    # may not contradict (or only partially support) the top-level claim.
    if nested_present and not nested_confirmed:
        return False
    return top_confirmed or nested_confirmed


def _ensure_script_team(
    execution_id: str,
    name: str | None,
    token_budget: int | None = None,
) -> dict[str, Any]:
    """Idempotent team provisioning. `token_budget` (meta.team.tokenBudget) is
    applied by the BFF only when the team row is CREATED — passing it on every
    ensure is safe and means whichever op runs first carries it."""
    status, body = _request(
        "POST",
        "/api/internal/team/ensure-script-team",
        {
            "executionId": execution_id,
            **({"name": name} if name else {}),
            **({"tokenBudget": token_budget} if token_budget else {}),
        },
    )
    if status >= 500:
        raise TeamOpsApiError(_client_error_message(status, body))
    if status >= 400:
        # Deterministic (unknown execution / no project) — surface to the script.
        return {"success": False, "error": _client_error_message(status, body)}
    return {"success": True, "teamId": body["teamId"], "leadSessionId": body["leadSessionId"]}


def _token_budget_from_input(input_data: dict) -> int | None:
    raw = input_data.get("teamTokenBudget")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    value = int(raw)
    return value if value > 0 else None


def _op_request(
    op: str,
    team_id: str,
    lead_session_id: str,
    args: dict[str, Any],
) -> tuple[int, Any]:
    """Map an op to its BFF endpoint call."""
    base = f"/api/internal/team/{quote(team_id, safe='')}"
    if op == "spawn":
        return _request(
            "POST",
            f"{base}/spawn",
            {
                "leadSessionId": lead_session_id,
                "agentSlug": args.get("agent"),
                "name": args.get("name"),
                "prompt": args.get("prompt"),
                **({"model": args["model"]} if args.get("model") else {}),
                "planModeRequired": bool(args.get("planModeRequired", False)),
            },
            acting_session_id=lead_session_id,
        )
    if op == "task":
        return _request(
            "POST",
            f"{base}/tasks",
            {
                "title": args.get("title"),
                **({"description": args["description"]} if args.get("description") else {}),
                **({"dependsOn": args["dependsOn"]} if args.get("dependsOn") else {}),
                **({"assignTo": args["assignTo"]} if args.get("assignTo") else {}),
                # 'queue' RESERVES the task for the designee's claim (pending,
                # dependency-gated) instead of handing it over in_progress —
                # the fix for the observed first-come role mismatch.
                **({"assignMode": args["assignMode"]} if args.get("assignMode") else {}),
                "createdBySessionId": lead_session_id,
            },
            acting_session_id=lead_session_id,
        )
    if op == "send":
        return _request(
            "POST",
            f"{base}/message",
            {
                "fromSessionId": lead_session_id,
                "to": args.get("to"),
                "content": args.get("content"),
            },
            acting_session_id=lead_session_id,
        )
    if op == "broadcast":
        return _request(
            "POST",
            f"{base}/broadcast",
            {"fromSessionId": lead_session_id, "content": args.get("content")},
            acting_session_id=lead_session_id,
        )
    if op == "status":
        return _request("GET", base, acting_session_id=lead_session_id)
    if op == "shutdown":
        name = args.get("name")
        if name:
            return _request(
                "POST",
                f"{base}/shutdown",
                {"requestedBySessionId": lead_session_id, "name": name},
                acting_session_id=lead_session_id,
            )
        # No name → shut down every member (run-terminal cleanup). Preserve a
        # partial result as 202 so the activity retry policy can finish the set.
        status, body = _request("GET", base, acting_session_id=lead_session_id)
        if status >= 400:
            return status, body
        members = body.get("members") if isinstance(body, dict) else None
        if not isinstance(members, list):
            raise TeamOpsApiError(
                "team shutdown status response was malformed (members must be a list)"
            )
        confirmed: list[str] = []
        stopping: list[str] = []
        for member in members:
            if not isinstance(member, dict):
                raise TeamOpsApiError(
                    "team shutdown status response was malformed (member must be an object)"
                )
            m_name = member.get("name")
            role = member.get("role")
            if not isinstance(m_name, str) or not m_name.strip():
                raise TeamOpsApiError(
                    "team shutdown status response was malformed (member name is required)"
                )
            if not isinstance(role, str) or not role.strip():
                raise TeamOpsApiError(
                    f"team shutdown status response was malformed (role missing for {m_name})"
                )
            # A mixed-version BFF may have written `shutdown` before durable
            # confirmation. Re-check every non-lead member idempotently.
            if role == "lead":
                continue
            s, shutdown_body = _request(
                "POST",
                f"{base}/shutdown",
                {"requestedBySessionId": lead_session_id, "name": m_name},
                acting_session_id=lead_session_id,
            )
            if s >= 400:
                return s, shutdown_body
            if _shutdown_confirmed(s, shutdown_body):
                confirmed.append(m_name)
            else:
                stopping.append(m_name)
        if stopping:
            return 202, {
                "ok": False,
                "state": "stopping",
                "shutdown": confirmed,
                "stopping": stopping,
            }
        return 200, {"ok": True, "state": "confirmed", "shutdown": confirmed}
    return 400, {"error": f"unknown team op '{op}'"}


@_bounded_http_attempt
def execute_team_op(ctx, input_data: dict) -> dict:
    """Dapr activity: run one script `team.*` op. See module docstring for the
    error contract. Input: {executionId, op, args?, teamName?, teamTokenBudget?}."""
    execution_id = str(input_data.get("executionId") or "").strip()
    op = str(input_data.get("op") or "").strip()
    args = input_data.get("args") if isinstance(input_data.get("args"), dict) else {}
    if not execution_id or not op:
        return {"success": False, "error": "executionId and op are required"}

    ensured = _ensure_script_team(
        execution_id,
        input_data.get("teamName"),
        _token_budget_from_input(input_data),
    )
    if not ensured.get("success"):
        return ensured
    team_id = ensured["teamId"]
    lead_session_id = ensured["leadSessionId"]

    status, body = _op_request(op, team_id, lead_session_id, args)
    if status >= 500:
        raise TeamOpsApiError(_client_error_message(status, body))
    if status >= 400:
        return {"success": False, "error": _client_error_message(status, body)}
    if status == 202:
        state = body.get("state") if isinstance(body, dict) else None
        raise TeamOpsApiError(
            f"team {op} accepted but not confirmed"
            + (f" (state={state})" if state else "")
        )
    if op == "shutdown" and not _shutdown_confirmed(status, body):
        state = body.get("state") if isinstance(body, dict) else None
        raise TeamOpsApiError(
            "team shutdown accepted but not confirmed"
            + (f" (state={state})" if state else "")
        )
    return {
        "success": True,
        "result": body if isinstance(body, (dict, list)) else {"raw": body},
        "teamId": team_id,
        "leadSessionId": lead_session_id,
    }


@_bounded_http_attempt
def get_team_state(ctx, input_data: dict) -> dict:
    """Dapr activity: the team view for the join predicate loop. Ensures the
    team first so join-before-spawn never 404s. Input: {executionId}."""
    execution_id = str(input_data.get("executionId") or "").strip()
    if not execution_id:
        return {"success": False, "error": "executionId is required"}
    ensured = _ensure_script_team(
        execution_id, None, _token_budget_from_input(input_data)
    )
    if not ensured.get("success"):
        return ensured
    status, body = _request(
        "GET",
        f"/api/internal/team/{quote(ensured['teamId'], safe='')}",
        acting_session_id=ensured["leadSessionId"],
    )
    if status >= 400:
        return {"success": False, "error": _client_error_message(status, body)}
    return {"success": True, "result": body}
