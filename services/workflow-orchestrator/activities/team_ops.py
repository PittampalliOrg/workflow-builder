"""Agent Teams operations for SCRIPT-LED teams ("the script is the lead").

The dynamic-script `team.*` primitives dispatch here. Every op first ensures the
script team exists (idempotent — POST /api/internal/team/ensure-script-team
derives teamId=`team-<executionId>` and the lead anchor session), then forwards
to the matching BFF internal team endpoint. Transport + auth mirror
``script_journal_client`` (Dapr service-invoke by default, direct HTTP when
``WORKFLOW_DATA_API_TRANSPORT=direct``; ``X-Internal-Token``).

Error contract (consumed by workflows/dynamic_script_workflow.py's journal +
the evaluator's team-call resolution):
  • 4xx from the BFF  -> return {"success": False, "error": "<msg>"} — journals
    as an `error` row, THROWN into the script (catchable). Deterministic
    failures (unknown agent slug, unknown teammate name, no project) must NOT
    retry.
  • transport / 5xx   -> raise — the activity retry policy retries.
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

import requests

from core.config import config


class TeamOpsApiError(RuntimeError):
    """Transport-level failure talking to the BFF team API (retriable)."""


def _timeout_seconds() -> float:
    try:
        return max(0.1, float(os.environ.get("WORKFLOW_DATA_API_TIMEOUT_SECONDS", "15")))
    except ValueError:
        return 15.0


def _direct_base_url() -> str:
    return os.environ.get(
        "WORKFLOW_BUILDER_URL",
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
    ).rstrip("/")


def _dapr_invoke_base_url() -> str:
    app_id = os.environ.get("WORKFLOW_BUILDER_APP_ID", "workflow-builder").strip()
    if not app_id:
        raise TeamOpsApiError("WORKFLOW_BUILDER_APP_ID is required for Dapr invocation")
    return f"http://{config.DAPR_HOST}:{config.DAPR_HTTP_PORT}/v1.0/invoke/{app_id}/method"


def _base_url() -> str:
    transport = str(os.environ.get("WORKFLOW_DATA_API_TRANSPORT") or "dapr").strip().lower()
    if transport == "direct":
        return _direct_base_url()
    if transport == "dapr":
        return _dapr_invoke_base_url()
    raise TeamOpsApiError(
        f"Unsupported WORKFLOW_DATA_API_TRANSPORT={transport!r}; use 'dapr' or 'direct'"
    )


def _request(method: str, path: str, json_body: dict[str, Any] | None = None) -> tuple[int, Any]:
    """One HTTP call. Returns (status, parsed-json-or-text). Raises on transport."""
    token = os.environ.get("INTERNAL_API_TOKEN", "").strip()
    if not token:
        raise TeamOpsApiError("INTERNAL_API_TOKEN is required for the team API")
    url = f"{_base_url()}/{path.lstrip('/')}"
    try:
        response = requests.request(
            method,
            url,
            headers={"Content-Type": "application/json", "X-Internal-Token": token},
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
                "createdBySessionId": lead_session_id,
            },
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
        )
    if op == "broadcast":
        return _request(
            "POST",
            f"{base}/broadcast",
            {"fromSessionId": lead_session_id, "content": args.get("content")},
        )
    if op == "status":
        return _request("GET", base)
    if op == "shutdown":
        name = args.get("name")
        if name:
            return _request(
                "POST",
                f"{base}/shutdown",
                {"requestedBySessionId": lead_session_id, "name": name},
            )
        # No name → shut down every member (run-terminal cleanup). Best-effort
        # per member; report the members targeted.
        status, body = _request("GET", base)
        if status >= 400:
            return status, body
        members = body.get("members") if isinstance(body, dict) else None
        targeted: list[str] = []
        for member in members or []:
            m_name = member.get("name")
            role = member.get("role")
            m_status = member.get("status")
            if role == "lead" or m_status == "shutdown" or not m_name:
                continue
            s, _ = _request(
                "POST",
                f"{base}/shutdown",
                {"requestedBySessionId": lead_session_id, "name": m_name},
            )
            if s < 400:
                targeted.append(m_name)
        return 200, {"ok": True, "shutdown": targeted}
    return 400, {"error": f"unknown team op '{op}'"}


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
    if status >= 400:
        return {"success": False, "error": _client_error_message(status, body)}
    return {
        "success": True,
        "result": body if isinstance(body, (dict, list)) else {"raw": body},
        "teamId": team_id,
        "leadSessionId": lead_session_id,
    }


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
        "GET", f"/api/internal/team/{quote(ensured['teamId'], safe='')}"
    )
    if status >= 400:
        return {"success": False, "error": _client_error_message(status, body)}
    return {"success": True, "result": body}
