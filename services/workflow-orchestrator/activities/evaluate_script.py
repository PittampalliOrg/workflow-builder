"""``evaluate_script`` activity — the bridge between the re-execution pump and the
stateless ``script-evaluator`` Node service.

Per design flaw #1 the journaled activity input stays small
(``{executionId, script, scriptSha256, meta, args, nested, budget, knownCallIds,
seenLogCount, limits}``); the potentially-large ``completedResults`` map is loaded
from the BFF journal HERE and forwarded over HTTP, never journaled into Dapr
history.

Error classification mirrors the AP-piece convention (``execute_action.py``):
  * transport / 5xx  -> RAISE (retried by ``_SCRIPT_EVAL_RETRY_POLICY`` in the
    workflow module),
  * 4xx (script_too_large / banned_api / invalid_meta) -> NON-retryable; returned
    as a synthesized ``status='script_error'`` evaluator response so the pump
    terminates deterministically without burning retry attempts.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import requests

from activities.script_journal_client import script_journal_client
from tracing import apply_workflow_activity_context, start_activity_span

logger = logging.getLogger(__name__)

DEFAULT_SCRIPT_EVALUATOR_URL = (
    "http://script-evaluator.workflow-builder.svc.cluster.local:8080"
)
_TERMINAL_JOURNAL_STATUSES = {"done", "null", "error", "skipped"}


def _evaluator_url() -> str:
    return os.environ.get("SCRIPT_EVALUATOR_URL", DEFAULT_SCRIPT_EVALUATOR_URL).rstrip("/")


def _completed_results_from_journal(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Build the ``completedResults`` map the evaluator consumes.

    Only TERMINAL rows (done/null/error/skipped) resolve an ``agent()`` promise;
    ``running`` rows (a structured-output retry in flight) are intentionally
    excluded so the evaluator re-issues the call and the pump re-dispatches it.
    """
    completed: dict[str, dict[str, Any]] = {}
    for row in rows:
        call_id = str(row.get("callId") or "").strip()
        status = str(row.get("status") or "").strip()
        if not call_id or status not in _TERMINAL_JOURNAL_STATUSES:
            continue
        completed[call_id] = {
            "status": status,
            "value": row.get("result"),
            "errorCode": row.get("errorCode"),
        }
    return completed


def _script_error_response(message: str, *, stack: str | None = None) -> dict[str, Any]:
    """A synthesized terminal ``script_error`` (shape per the SSOT contract)."""
    return {
        "status": "script_error",
        "tasks": [],
        "returnValue": None,
        "error": {"message": message, "stack": stack},
        "phases": {"declared": [], "current": None},
        "newLogs": [],
        "logCount": 0,
        "counts": {"totalCallsSeen": 0},
        "evaluatorVersion": None,
    }


def evaluate_script(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Load the journal, POST ``/evaluate``, return the evaluator response body.

    Input keys: ``executionId, script, scriptSha256, meta, args, nested, budget,
    knownCallIds, seenLogCount, limits``.
    """
    execution_id = str(input_data.get("executionId") or "").strip()
    if not execution_id:
        raise RuntimeError("evaluate_script: executionId is required")

    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    otel = apply_workflow_activity_context(otel)

    attrs = {
        "action.type": "evaluate_script",
        "workflow.db_execution_id": execution_id,
        "script.nested": bool(input_data.get("nested")),
        "script.seen_log_count": int(input_data.get("seenLogCount") or 0),
    }

    with start_activity_span("activity.evaluate_script", otel, attrs):
        # 1. Load journal rows (BFF) -> completedResults. This is the ONLY place
        #    the full result map materializes; it is forwarded over HTTP, not
        #    journaled into Dapr history.
        rows = script_journal_client.list_script_calls(execution_id)
        completed_results = _completed_results_from_journal(rows)
        # Journal-authoritative known set (includes journal-imported done rows the
        # pump never dispatched). Union with the pump's view for safety.
        pump_known = {
            str(c).strip()
            for c in (input_data.get("knownCallIds") or [])
            if str(c).strip()
        }
        known_call_ids = sorted(set(completed_results.keys()) | pump_known)

        request_body = {
            "script": input_data.get("script") or "",
            "scriptSha256": input_data.get("scriptSha256") or "",
            "meta": input_data.get("meta") or {},
            "nested": bool(input_data.get("nested")),
            "budget": input_data.get("budget")
            or {"total": None, "spent": 0, "exhausted": False, "lifetimeExceeded": False},
            "completedResults": completed_results,
            "knownCallIds": known_call_ids,
            "seenLogCount": int(input_data.get("seenLogCount") or 0),
            "limits": input_data.get("limits") or {},
        }
        # args is verbatim any-JSON; key-absence propagates so the script's
        # `args` global is undefined when no input was provided.
        if "args" in input_data:
            request_body["args"] = input_data.get("args")

        endpoint = f"{_evaluator_url()}/evaluate"
        try:
            response = requests.post(
                endpoint,
                json=request_body,
                timeout=30,
            )
        except requests.exceptions.RequestException as exc:
            # Transport failure -> retryable (RAISE so the workflow RetryPolicy fires).
            logger.warning("[evaluate_script] transport error calling %s: %s", endpoint, exc)
            raise RuntimeError(f"evaluate_script: request failed: {exc}") from exc

        if response.status_code >= 500:
            body_preview = response.text[:400] if response.text else "<empty>"
            logger.warning(
                "[evaluate_script] retryable HTTP %s from evaluator: %s",
                response.status_code,
                body_preview,
            )
            raise RuntimeError(
                f"evaluate_script: evaluator HTTP {response.status_code}: {body_preview}"
            )

        if response.status_code >= 400:
            # 4xx = permanent script/meta error. Surface as a terminal script_error
            # (non-retryable) so the pump stops without burning retry attempts.
            body_preview = response.text[:800] if response.text else "<empty>"
            message = body_preview
            try:
                parsed = response.json()
                if isinstance(parsed, dict):
                    err = parsed.get("error")
                    if isinstance(err, dict) and err.get("message"):
                        message = str(err.get("message"))
                    elif isinstance(err, str):
                        message = err
                    elif parsed.get("message"):
                        message = str(parsed.get("message"))
            except ValueError:
                pass
            logger.warning(
                "[evaluate_script] non-retryable HTTP %s from evaluator: %s",
                response.status_code,
                body_preview,
            )
            return _script_error_response(
                f"evaluator rejected script (HTTP {response.status_code}): {message}"
            )

        try:
            body = response.json()
        except ValueError as exc:
            raise RuntimeError(f"evaluate_script: invalid JSON from evaluator: {exc}") from exc
        if not isinstance(body, dict):
            raise RuntimeError(
                f"evaluate_script: expected object from evaluator, got {type(body).__name__}"
            )
        status = body.get("status")
        if status not in {"need", "done", "script_error"}:
            raise RuntimeError(
                f"evaluate_script: evaluator returned unknown status {status!r}"
            )
        if not isinstance(body.get("tasks"), list):
            body["tasks"] = []
        return body
