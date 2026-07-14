"""``record_script_call_result`` + ``import_script_journal`` activities.

``record_script_call_result`` is the single point where a finished child result is
normalized into an ``agent()`` return value + a persisted ``workflow_script_calls``
row (idempotent PUT). It owns the structured-output contract: fence-strip the
model's text, pull the first balanced JSON object, validate against the call's
schema, and decide done / null / error / retry_structured.

Normalization (design §Architecture, plan §Workstream 2):
  * user skip                                   -> status ``skipped`` (agent()->null)
  * kind=workflow + child success               -> status ``done``, result = child returnValue
  * kind=workflow + child failure/unresolved    -> status ``error``,
        error_code ``workflow_child_error``, result = {message} — the evaluator
        THROWS this into the script (workflow() throws, agent() nulls)
  * cancelled / success:false / exception / timeout / empty -> status ``null``
  * schema present + valid                      -> status ``done``, result = object
  * schema present + invalid + retries < cap    -> return ``retry_structured`` +
        refresh a ``running`` row (NO terminal row) so the pump re-dispatches
  * schema present + invalid + retries >= cap   -> status ``error``,
        error_code ``error_max_structured_output_retries``
  * no schema                                   -> status ``done``, result = text (cap 256 KB)
"""

from __future__ import annotations

import json
import logging
from typing import Any

from jsonschema import Draft202012Validator

from activities.script_journal_client import script_journal_client
from tracing import apply_workflow_activity_context, start_activity_span

logger = logging.getLogger(__name__)

_MAX_RESULT_BYTES = 256 * 1024
_MAX_FEEDBACK_CHARS = 2000
_DEFAULT_MAX_STRUCTURED_RETRIES = 5
_ERROR_MAX_STRUCTURED_RETRIES = "error_max_structured_output_retries"
_ERROR_WORKFLOW_CHILD = "workflow_child_error"
_ERROR_ACTION = "action_error"


def _cap_json_result(value: Any) -> Any:
    """Bound non-string results the way ``_cap_result`` bounds text: an
    oversized action()/workflow() payload otherwise rides pump history and
    every /evaluate completedResults POST toward the 16MiB gRPC ceiling."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    try:
        encoded = json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return {"truncated": True, "reason": "unserializable result"}
    size = len(encoded.encode("utf-8"))
    if size <= _MAX_RESULT_BYTES:
        return value
    return {
        "truncated": True,
        "bytes": size,
        "preview": encoded[: 4 * 1024],
    }


def _as_int(value: Any, default: int = 0) -> int:
    try:
        if isinstance(value, bool):
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def _extract_content(raw: Any) -> str:
    """Best-effort final-text extraction from a session_workflow child result."""
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, dict):
        for key in ("content", "output", "finalOutput", "final_output", "text", "message", "result"):
            value = raw.get(key)
            if isinstance(value, str) and value.strip():
                return value
        # Nested { output: { content } } shapes.
        output = raw.get("output")
        if isinstance(output, dict):
            for key in ("content", "text", "message"):
                value = output.get(key)
                if isinstance(value, str) and value.strip():
                    return value
        return ""
    return str(raw)


def _strip_code_fences(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        # Drop the opening fence line (``` or ```json) and the trailing fence.
        newline = stripped.find("\n")
        if newline != -1:
            stripped = stripped[newline + 1 :]
        if stripped.rstrip().endswith("```"):
            stripped = stripped.rstrip()[: -3]
    return stripped


def _first_balanced_json_object(text: str) -> Any | None:
    """Return the first balanced top-level JSON value ({...} or [...]) in *text*.

    Scans for the first ``{`` or ``[`` and walks matching brackets while honoring
    string literals + escapes, so prose surrounding the JSON is ignored.
    """
    candidate = _strip_code_fences(text)
    # Fast path: the whole (fence-stripped) payload is JSON.
    try:
        return json.loads(candidate)
    except (ValueError, TypeError):
        pass
    for opener, closer in (("{", "}"), ("[", "]")):
        start = candidate.find(opener)
        if start == -1:
            continue
        depth = 0
        in_string = False
        escaped = False
        for idx in range(start, len(candidate)):
            ch = candidate[idx]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == opener:
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    fragment = candidate[start : idx + 1]
                    try:
                        return json.loads(fragment)
                    except (ValueError, TypeError):
                        break
    return None


def _validation_errors(schema: dict[str, Any], instance: Any) -> list[str]:
    validator = Draft202012Validator(schema)
    messages: list[str] = []
    for error in sorted(validator.iter_errors(instance), key=lambda e: list(e.path)):
        location = "/".join(str(p) for p in error.path) or "<root>"
        messages.append(f"{location}: {error.message}")
    return messages


def _cap_result(value: Any) -> Any:
    if isinstance(value, str) and len(value.encode("utf-8", "ignore")) > _MAX_RESULT_BYTES:
        # Truncate on a byte boundary that stays valid UTF-8.
        return value.encode("utf-8", "ignore")[:_MAX_RESULT_BYTES].decode("utf-8", "ignore")
    return value


def _session_id_from_raw(raw: Any) -> str | None:
    if not isinstance(raw, dict):
        return None
    for key in ("sessionId", "daprInstanceId", "agentWorkflowId"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _tokens_from_raw(raw: Any) -> int:
    if not isinstance(raw, dict):
        return 0
    for key in ("tokensUsed", "totalTokens"):
        if key in raw:
            return _as_int(raw.get(key))
    usage = raw.get("usage")
    if isinstance(usage, dict):
        return _as_int(usage.get("totalTokens") or usage.get("total_tokens"))
    return 0


def _is_null_result(raw: Any) -> bool:
    if raw is None:
        return True
    if not isinstance(raw, dict):
        return False
    if raw.get("skipped"):
        return False
    if raw.get("cancelled"):
        return True
    if "success" in raw and not raw.get("success"):
        return True
    if raw.get("error") and not raw.get("content"):
        return True
    return False


def record_script_call_dispatch(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Journal a non-terminal ``running`` row the moment a call is dispatched.

    Terminal rows are written only by ``record_script_call_result``; this row
    exists so the run UI can show in-flight calls (and, for agent() calls,
    attach the child session's live transcript via ``sessionId`` — the child
    instance id is deterministic and known at dispatch). Clobber safety comes
    from activity ordering: for a given call the dispatch write always
    happens-before its result write, and Dapr replay returns recorded results
    without re-executing. Best-effort — a failed write never blocks dispatch.

    Input: ``{executionId, callId, seq, sessionId?, spec:{kind,label,phase,
    promptSha256,baseHash,occurrence,retries}}``.
    """
    execution_id = str(input_data.get("executionId") or "").strip()
    call_id = str(input_data.get("callId") or "").strip()
    if not execution_id or not call_id:
        return {"success": False, "error": "executionId and callId are required"}

    spec = input_data.get("spec") if isinstance(input_data.get("spec"), dict) else {}
    session_id = input_data.get("sessionId")
    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    otel = apply_workflow_activity_context(otel)

    row = {
        "seq": _as_int(input_data.get("seq")),
        "kind": spec.get("kind") or "agent",
        "baseHash": spec.get("baseHash"),
        "occurrence": _as_int(spec.get("occurrence")),
        "label": spec.get("label"),
        "phase": spec.get("phase"),
        "promptSha256": spec.get("promptSha256"),
        "status": "running",
        "sessionId": session_id if isinstance(session_id, str) and session_id else None,
        "retries": _as_int(spec.get("retries")),
        "tokensUsed": 0,
        "result": None,
        "callSite": spec.get("callSite") if isinstance(spec.get("callSite"), dict) else None,
    }

    attrs = {
        "action.type": "record_script_call_dispatch",
        "workflow.db_execution_id": execution_id,
        "script.call_id": call_id,
    }
    with start_activity_span("activity.record_script_call_dispatch", otel, attrs):
        try:
            script_journal_client.put_script_call(execution_id, call_id, row)
        except Exception as exc:  # noqa: BLE001 — in-flight visibility is best-effort
            logger.warning(
                "[record_script_call_dispatch] journal PUT failed for %s/%s: %s",
                execution_id,
                call_id,
                exc,
            )
            return {"success": False, "error": str(exc)}
    return {"success": True}


def record_script_call_pause(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Journal an AP WEBHOOK pause marker into a call's RUNNING row.

    ``result.pause = {type, requestId, waiterInstanceId}`` lets the BFF
    ap-resume route raise ``ap.resume.<requestId>`` at the WAITER (the
    action_runner child) instead of the root pump instance. Non-terminal:
    the eventual ``record_script_call_result`` write replaces the row.
    Best-effort — a failed write must not fail the runner (the resume then
    degrades to root-targeted, i.e. lost, visible as a stuck running row).

    Input: ``{executionId, callId, seq, spec, pause:{type,requestId,
    waiterInstanceId}}``.
    """
    execution_id = str(input_data.get("executionId") or "").strip()
    call_id = str(input_data.get("callId") or "").strip()
    if not execution_id or not call_id:
        return {"success": False, "error": "executionId and callId are required"}

    spec = input_data.get("spec") if isinstance(input_data.get("spec"), dict) else {}
    pause = input_data.get("pause") if isinstance(input_data.get("pause"), dict) else {}
    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    otel = apply_workflow_activity_context(otel)

    row = {
        "seq": _as_int(input_data.get("seq")),
        "kind": spec.get("kind") or "action",
        "baseHash": spec.get("baseHash"),
        "occurrence": _as_int(spec.get("occurrence")),
        "label": spec.get("label"),
        "phase": spec.get("phase"),
        "promptSha256": spec.get("promptSha256"),
        "status": "running",
        "sessionId": None,
        "retries": _as_int(spec.get("retries")),
        "tokensUsed": 0,
        "result": {"pause": pause},
        "callSite": spec.get("callSite") if isinstance(spec.get("callSite"), dict) else None,
    }

    attrs = {
        "action.type": "record_script_call_pause",
        "workflow.db_execution_id": execution_id,
        "script.call_id": call_id,
    }
    with start_activity_span("activity.record_script_call_pause", otel, attrs):
        try:
            script_journal_client.put_script_call(execution_id, call_id, row)
        except Exception as exc:  # noqa: BLE001 — pause visibility is best-effort
            logger.warning(
                "[record_script_call_pause] journal PUT failed for %s/%s: %s",
                execution_id,
                call_id,
                exc,
            )
            return {"success": False, "error": str(exc)}
    return {"success": True}


def record_script_call_result(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Normalize + journal one finished script call.

    Input: ``{executionId, callId, seq?, spec:{kind,label,phase,promptSha256,
    baseHash,occurrence,schema,retries,maxStructuredRetries}, raw}``.

    Returns ``{status, feedback?, errorCode?}`` for the pump. ``retry_structured``
    is the ONLY non-terminal status (no terminal journal row written).
    """
    execution_id = str(input_data.get("executionId") or "").strip()
    call_id = str(input_data.get("callId") or "").strip()
    if not execution_id or not call_id:
        return {"status": "null", "error": "executionId and callId are required"}

    spec = input_data.get("spec") if isinstance(input_data.get("spec"), dict) else {}
    raw = input_data.get("raw")
    schema = spec.get("schema") if isinstance(spec.get("schema"), dict) else None
    retries = _as_int(spec.get("retries"))
    max_structured_retries = _as_int(
        spec.get("maxStructuredRetries"), _DEFAULT_MAX_STRUCTURED_RETRIES
    )
    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    otel = apply_workflow_activity_context(otel)

    def _base_row(status: str) -> dict[str, Any]:
        return {
            "seq": _as_int(input_data.get("seq")),
            "kind": spec.get("kind") or "agent",
            "baseHash": spec.get("baseHash"),
            "occurrence": _as_int(spec.get("occurrence")),
            "label": spec.get("label"),
            "phase": spec.get("phase"),
            "promptSha256": spec.get("promptSha256"),
            "status": status,
            "sessionId": _session_id_from_raw(raw),
            "retries": retries,
            "tokensUsed": _tokens_from_raw(raw),
            "callSite": spec.get("callSite") if isinstance(spec.get("callSite"), dict) else None,
        }

    def _persist(row: dict[str, Any]) -> None:
        try:
            script_journal_client.put_script_call(execution_id, call_id, row)
        except Exception as exc:  # noqa: BLE001 — journal write is best-effort within retries
            logger.warning(
                "[record_script_call_result] journal PUT failed for %s/%s: %s",
                execution_id,
                call_id,
                exc,
            )
            raise

    attrs = {
        "action.type": "record_script_call_result",
        "workflow.db_execution_id": execution_id,
        "script.call_id": call_id,
        "script.has_schema": bool(schema),
        "script.retries": retries,
    }

    with start_activity_span("activity.record_script_call_result", otel, attrs):
        # 1. Skip (user control event).
        if isinstance(raw, dict) and raw.get("skipped"):
            row = _base_row("skipped")
            row["result"] = None
            _persist(row)
            return {"status": "skipped"}

        # 2. Nested workflow() child — checked BEFORE the null short-circuit
        #    because workflow() failure semantics differ from agent(): per the
        #    Workflow-tool contract, workflow() THROWS on an unresolvable ref /
        #    child error (so authors can try/catch), while agent() resolves null.
        #    Success resolves to the child's returnValue object (a
        #    dynamic_script_workflow_v1 result is {returnValue, status, ...},
        #    which _extract_content can't reach — it only pulls string keys).
        if (spec.get("kind") or "agent") == "workflow":
            if isinstance(raw, dict) and raw.get("success") and not _is_null_result(raw):
                row = _base_row("done")
                row["result"] = _cap_json_result(raw.get("returnValue"))
                _persist(row)
                return {"status": "done"}
            message = None
            if isinstance(raw, dict):
                err = raw.get("error")
                if isinstance(err, str) and err.strip():
                    message = err.strip()
                elif raw.get("cancelled"):
                    message = "workflow() child was cancelled"
            if not message:
                message = "workflow() child failed"
            row = _base_row("error")
            # The message rides in result so the evaluator can throw it verbatim
            # into the script (no journal-schema change needed).
            row["result"] = {"message": message}
            row["errorCode"] = _ERROR_WORKFLOW_CHILD
            _persist(row)
            return {"status": "error", "errorCode": _ERROR_WORKFLOW_CHILD}

        # 2b. Team op (script-led teams). Same THROW-on-failure contract as
        #     workflow(): success -> done with the op result (plain JSON — no
        #     schema validation, no structured retries); anything else -> error
        #     whose message the evaluator throws into the script (catchable).
        if (spec.get("kind") or "agent") == "team":
            if isinstance(raw, dict) and raw.get("success"):
                row = _base_row("done")
                row["result"] = raw.get("result")
                # Spawn results carry the teammate's session id — backfill it so
                # the run rail's spawn row is clickable straight into the
                # teammate transcript (rail rows select by sessionId).
                if spec.get("teamOp") == "spawn":
                    res = raw.get("result")
                    sid = res.get("sessionId") if isinstance(res, dict) else None
                    if isinstance(sid, str) and sid.strip():
                        row["sessionId"] = sid.strip()
                _persist(row)
                return {"status": "done"}
            message = None
            if isinstance(raw, dict):
                err = raw.get("error")
                if isinstance(err, str) and err.strip():
                    message = err.strip()
                elif raw.get("cancelled"):
                    message = "team op was cancelled"
            if not message:
                message = f"team.{spec.get('teamOp') or 'op'} failed"
            row = _base_row("error")
            row["result"] = {"message": message}
            row["errorCode"] = "team_op_error"
            _persist(row)
            return {"status": "error", "errorCode": "team_op_error"}

        # 2c. Deterministic action() (contract 1.2.0). Same THROW-side contract
        #     as workflow(): failure journals `error` (the evaluator throws the
        #     message, catchable) — UNLESS opts.allowFailure, which journals
        #     `done` with the {success:false} envelope so the evaluator needs no
        #     allowFailure branch (docs/code-first-cutover.md item 6).
        if (spec.get("kind") or "agent") == "action":
            action_opts = (
                spec.get("actionOpts") if isinstance(spec.get("actionOpts"), dict) else {}
            )
            if isinstance(raw, dict) and raw.get("success"):
                row = _base_row("done")
                row["result"] = _cap_json_result(raw.get("data"))
                _persist(row)
                return {"status": "done"}
            if action_opts.get("allowFailure") is True:
                envelope = raw if isinstance(raw, dict) else {"error": str(raw)}
                row = _base_row("done")
                row["result"] = _cap_json_result(
                    {
                        "success": False,
                        "error": envelope.get("error"),
                        "data": envelope.get("data"),
                    }
                )
                _persist(row)
                return {"status": "done"}
            message = None
            if isinstance(raw, dict):
                err = raw.get("error")
                if isinstance(err, str) and err.strip():
                    message = err.strip()
                elif raw.get("cancelled"):
                    message = "action() was cancelled"
            if not message:
                message = f"action('{spec.get('actionSlug') or ''}') failed"
            row = _base_row("error")
            row["result"] = {"message": message}
            row["errorCode"] = _ERROR_ACTION
            _persist(row)
            return {"status": "error", "errorCode": _ERROR_ACTION}

        # 2d. sleep(): always resolves (the pump synthesizes the envelope when
        #     the timer fires; a dispatch error still lands here as done=False →
        #     treat any dict without success as a resolved no-op: sleep never
        #     throws into the script).
        if (spec.get("kind") or "agent") == "sleep":
            if isinstance(raw, dict) and raw.get("success"):
                row = _base_row("done")
                row["result"] = {"sleptSeconds": raw.get("sleptSeconds", spec.get("seconds"))}
                _persist(row)
                return {"status": "done"}
            # Dispatch error (invalid seconds / cap) — journal error so the run
            # rail shows the reason; the evaluator still RESOLVES sleep() to null.
            message = (
                str(raw.get("error")).strip()
                if isinstance(raw, dict) and raw.get("error")
                else "sleep() failed"
            )
            row = _base_row("error")
            row["result"] = {"message": message}
            row["errorCode"] = "sleep_error"
            _persist(row)
            return {"status": "error", "errorCode": "sleep_error"}

        # 2e. Approval/event gates: resolve whatever arrived ({timedOut: true}
        #     on timeout) — never an error for time. A dispatch failure journals
        #     error for run-rail visibility; the evaluator resolves null.
        if (spec.get("kind") or "agent") == "event":
            if isinstance(raw, dict) and raw.get("success") is False and raw.get("error"):
                row = _base_row("error")
                row["result"] = {"message": str(raw.get("error")).strip()}
                row["errorCode"] = "event_dispatch_error"
                _persist(row)
                return {"status": "error", "errorCode": "event_dispatch_error"}
            row = _base_row("done")
            row["result"] = _cap_json_result(raw if isinstance(raw, dict) else {"value": raw})
            _persist(row)
            return {"status": "done"}

        # 3. Death / cancel / failure / timeout -> null.
        if _is_null_result(raw):
            row = _base_row("null")
            row["result"] = None
            _persist(row)
            return {"status": "null"}

        content = _extract_content(raw)

        # 4. No schema -> done with the raw text.
        if not schema:
            row = _base_row("done")
            row["result"] = _cap_result(content)
            _persist(row)
            return {"status": "done"}

        # 5. Schema present -> extract + validate.
        parsed = _first_balanced_json_object(content)
        errors: list[str]
        if parsed is None:
            errors = ["<root>: no JSON value found in model output"]
        else:
            errors = _validation_errors(schema, parsed)

        if not errors:
            row = _base_row("done")
            row["result"] = parsed
            _persist(row)
            return {"status": "done"}

        # Invalid structured output.
        if retries < max_structured_retries:
            feedback = "\n".join(errors)[:_MAX_FEEDBACK_CHARS]
            # Refresh a NON-terminal running row; the pump re-dispatches this call.
            row = _base_row("running")
            row["result"] = None
            try:
                _persist(row)
            except Exception:
                pass  # non-terminal bookkeeping — never block the retry decision
            return {"status": "retry_structured", "feedback": feedback}

        # Exhausted structured-output retries.
        row = _base_row("error")
        row["result"] = None
        row["errorCode"] = _ERROR_MAX_STRUCTURED_RETRIES
        _persist(row)
        return {"status": "error", "errorCode": _ERROR_MAX_STRUCTURED_RETRIES}


def import_script_journal(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Import ``done`` journal rows from a prior execution (resume-after-edit)."""
    execution_id = str(input_data.get("executionId") or "").strip()
    from_execution_id = str(input_data.get("fromExecutionId") or "").strip()
    if not execution_id or not from_execution_id:
        return {"success": False, "error": "executionId and fromExecutionId are required"}

    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    otel = apply_workflow_activity_context(otel)
    attrs = {
        "action.type": "import_script_journal",
        "workflow.db_execution_id": execution_id,
        "script.import_from": from_execution_id,
    }
    with start_activity_span("activity.import_script_journal", otel, attrs):
        try:
            result = script_journal_client.import_script_calls(execution_id, from_execution_id)
            return {"success": True, "imported": _as_int(result.get("imported"))}
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[import_script_journal] import failed for %s from %s: %s",
                execution_id,
                from_execution_id,
                exc,
            )
            return {"success": False, "error": str(exc)}
