"""
Persist Results Activity

Persists the final workflow output through the workflow-data API so orchestration
persistence stays behind the workflow-builder application boundary.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from core.config import config
from core.output_summary import SUMMARY_OUTPUT_KEYS, extract_summary_fields_from_outputs
from activities.workflow_data_client import workflow_data_client
from tracing import extract_otel_trace_id, set_current_span_attrs, start_activity_span

logger = logging.getLogger(__name__)


def _coerce_duration_ms(value: Any) -> int | None:
    """Best-effort convert duration input to a non-negative integer."""
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def persist_results_to_db(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """
    Persist final workflow output to the workflow_executions table.

    Called as the last activity before the workflow returns. Skips if
    dbExecutionId is not provided (e.g., direct orchestrator API calls).

    Args:
        ctx: Dapr workflow context (required by Dapr, not used)
        input_data: Dict with keys:
            - dbExecutionId: Database execution ID (workflow_executions.id)
            - outputs: Per-node output dict {nodeId: data, ...}
            - success: Whether the workflow succeeded
            - error: Error message (if failed)
            - durationMs: Total execution duration in milliseconds

    Returns:
        Dict with success status
    """
    db_execution_id = input_data.get("dbExecutionId")
    if not db_execution_id:
        return {"success": True, "skipped": True}

    outputs = input_data.get("outputs")
    workflow_output = input_data.get("workflowOutput")
    success = input_data.get("success", True)
    error = input_data.get("error")
    requested_phase = str(input_data.get("phase") or "").strip().lower()
    cancelled = requested_phase in {"cancelled", "canceled"}
    status = "cancelled" if cancelled else ("success" if success else "error")
    phase = "cancelled" if cancelled else ("completed" if success else "failed")
    duration_ms = _coerce_duration_ms(input_data.get("durationMs"))
    otel = input_data.get("_otel") or {}
    trace_id = extract_otel_trace_id(otel if isinstance(otel, dict) else None)

    logger.info(
        f"[Persist Results] Writing output to DB for execution: {db_execution_id} "
        f"(success={success}, duration={duration_ms}ms)"
    )

    attrs = {
        "db.execution_id": db_execution_id,
        "action.type": "persist_results_to_db",
    }

    outputs_size_chars = None
    try:
        if isinstance(outputs, (dict, list)):
            import json as _json
            outputs_size_chars = len(_json.dumps(outputs, default=str))
    except Exception:
        pass

    set_current_span_attrs({
        "workflow.execution.db_id": db_execution_id,
        "workflow.execution.id": input_data.get("executionId"),
        "workflow.success": bool(success),
        "workflow.phase": phase,
        "workflow.duration_ms": duration_ms,
        "workflow.error": (error or "")[:500] if error else None,
        "workflow.outputs.size_chars": outputs_size_chars,
        "workflow.outputs.node_count": (
            len(outputs) if isinstance(outputs, dict) else None
        ),
        "workflow.has_workflow_output": workflow_output is not None,
    })

    with start_activity_span("activity.persist_results_to_db", otel, attrs):
        try:
            summary_fields = extract_summary_fields_from_outputs(outputs)
            for key in SUMMARY_OUTPUT_KEYS:
                explicit = input_data.get(key)
                if explicit is not None:
                    summary_fields[key] = explicit

            # Build the final output object (same structure as orchestrator return)
            final_output = {
                "success": success,
                "outputs": outputs,
                "workflowOutput": workflow_output,
                "durationMs": duration_ms,
                "phase": phase,
            }
            final_output.update(summary_fields)
            if error:
                final_output["error"] = error

            progress = 100
            completed_at = datetime.now(timezone.utc)

            execution_row = workflow_data_client.get_execution(str(db_execution_id)) or {}
            started_at = _parse_iso_datetime(execution_row.get("startedAt"))
            computed_duration_ms = None
            if started_at:
                computed_duration_ms = max(
                    int((completed_at - started_at).total_seconds() * 1000), 0
                )
            persisted_duration_ms = (
                computed_duration_ms
                if computed_duration_ms is not None
                else duration_ms
            )
            if duration_ms is None and computed_duration_ms is not None:
                # The pump's terminal persist never passes durationMs — backfill
                # final_output from startedAt->completedAt so output.durationMs
                # is not null on completed runs (mirrors the duration column).
                final_output["durationMs"] = computed_duration_ms
            projection = workflow_data_client.patch_execution(
                str(db_execution_id),
                {
                    "output": final_output,
                    "summaryOutput": summary_fields or None,
                    "status": status,
                    "phase": phase,
                    "progress": progress,
                    "error": None if success else error,
                    "completedAt": completed_at.isoformat(),
                    "duration": (
                        str(persisted_duration_ms)
                        if persisted_duration_ms is not None
                        else None
                    ),
                    **(
                        {"primaryTraceId": trace_id}
                        if trace_id and not execution_row.get("primaryTraceId")
                        else {}
                    ),
                },
            )

            if projection.get("applied") is False:
                reason = str(projection.get("reason") or "superseded")
                logger.info(
                    "[Persist Results] Runtime projection superseded for %s: %s",
                    db_execution_id,
                    reason,
                )
                return {
                    "success": True,
                    "persisted": False,
                    "reason": reason,
                }

            logger.info(
                "[Persist Results] Successfully persisted output via workflow-data for: %s",
                db_execution_id,
            )
            return {"success": True}

        except Exception as e:
            logger.error(
                f"[Persist Results] Failed to persist output for {db_execution_id}: {e}"
            )
            # Don't throw - persistence failure shouldn't break workflow execution
            return {"success": False, "error": str(e)}
