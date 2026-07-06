"""``aggregate_script_usage`` activity — the ``budget`` accrual source.

Returns the SUM of goal-loop token usage across every session in the execution
tree (the BFF computes it from ``agent.llm_usage`` session events). The pump calls
this once per loop iteration BEFORE ``evaluate_script`` so budget throws are
synthesized against fresh spend.
"""

from __future__ import annotations

import logging
from typing import Any

from activities.script_journal_client import script_journal_client
from tracing import apply_workflow_activity_context, start_activity_span

logger = logging.getLogger(__name__)


def _as_int(value: Any, default: int = 0) -> int:
    try:
        if isinstance(value, bool):
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def aggregate_script_usage(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Return ``{"totalTokens": int}`` for the execution tree.

    Best-effort: a transient BFF failure returns 0 rather than raising, so a usage
    hiccup can't wedge the pump (budget under-counts for one round, then catches up).
    """
    execution_id = str(input_data.get("executionId") or "").strip()
    if not execution_id:
        return {"totalTokens": 0}

    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    otel = apply_workflow_activity_context(otel)
    attrs = {
        "action.type": "aggregate_script_usage",
        "workflow.db_execution_id": execution_id,
    }
    with start_activity_span("activity.aggregate_script_usage", otel, attrs):
        try:
            payload = script_journal_client.get_llm_usage(execution_id)
            return {"totalTokens": _as_int(payload.get("totalTokens"))}
        except Exception as exc:  # noqa: BLE001 — budget accrual must not wedge the pump
            logger.warning(
                "[aggregate_script_usage] usage lookup failed for %s: %s",
                execution_id,
                exc,
            )
            return {"totalTokens": 0}
