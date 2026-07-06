"""``append_script_logs`` activity — mirrors ``log()`` lines into
``workflow_execution_logs`` so the run-detail Live console lights up.

Reuses the same ``workflow_data_client.append_execution_log`` write path as
``log_node_execution`` (one row per line). Called by the pump ONLY when the
evaluator reports non-empty ``newLogs``; ``startIndex`` = the pump's
``seenLogCount`` so each line gets a stable, monotonic node id (idempotent under
Dapr activity replay/retry).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from activities.workflow_data_client import workflow_data_client
from tracing import apply_workflow_activity_context, start_activity_span

logger = logging.getLogger(__name__)


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def append_script_logs(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Append ``logs`` (a list of strings) as ``workflow_execution_logs`` rows.

    Input: ``{executionId, logs: [str, ...], startIndex}``.
    """
    execution_id = str(input_data.get("executionId") or "").strip()
    logs = input_data.get("logs")
    start_index = input_data.get("startIndex") or 0
    try:
        start_index = int(start_index)
    except (TypeError, ValueError):
        start_index = 0
    if not execution_id or not isinstance(logs, list) or not logs:
        return {"success": True, "appended": 0}

    otel = input_data.get("_otel") if isinstance(input_data.get("_otel"), dict) else {}
    otel = apply_workflow_activity_context(otel)
    attrs = {
        "action.type": "append_script_logs",
        "workflow.db_execution_id": execution_id,
        "script.log_count": len(logs),
    }
    appended = 0
    with start_activity_span("activity.append_script_logs", otel, attrs):
        for offset, line in enumerate(logs):
            index = start_index + offset
            log_id = f"{execution_id}-scriptlog-{index}"
            try:
                workflow_data_client.append_execution_log(
                    execution_id,
                    {
                        "id": log_id,
                        "nodeId": f"script-log-{index}",
                        "nodeName": "script.log",
                        "nodeType": "script-log",
                        "activityName": "log",
                        "status": "success",
                        "output": {"message": str(line)},
                        "startedAt": _iso_now(),
                        "completedAt": _iso_now(),
                    },
                )
                appended += 1
            except Exception as exc:  # noqa: BLE001 — logging must never break the workflow
                logger.warning(
                    "[append_script_logs] append failed for %s line %s: %s",
                    execution_id,
                    index,
                    exc,
                )
    return {"success": True, "appended": appended}
