"""Best-effort MLflow trace finalization activity."""

from __future__ import annotations

import logging
from typing import Any

from tracing import emit_mlflow_trace_root_span, set_current_span_attrs

logger = logging.getLogger(__name__)


def finalize_mlflow_trace_root(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Emit a synthetic OTLP root span for the workflow's existing trace ID."""
    _ = ctx
    input_data = input_data or {}

    set_current_span_attrs({
        "workflow.id": input_data.get("workflowId"),
        "workflow.name": input_data.get("workflowName"),
        "workflow.execution.id": input_data.get("executionId"),
        "workflow.execution.db_id": input_data.get("dbExecutionId"),
        "workflow.instance_id": input_data.get("daprInstanceId")
        or input_data.get("workflowInstanceId"),
        "workflow.status": input_data.get("status") or input_data.get("statusCode"),
        "mlflow.trace_id": input_data.get("traceId"),
        "mlflow.trace_name": input_data.get("traceName"),
    })

    try:
        result = emit_mlflow_trace_root_span(input_data)
        set_current_span_attrs({
            "mlflow.finalize.success": bool(result.get("success")),
            "mlflow.finalize.skipped": bool(result.get("skipped")),
            "mlflow.finalize.skip_reason": result.get("reason"),
            "mlflow.finalize.error": (result.get("error") or "")[:500] if result.get("error") else None,
        })
        if not result.get("success") and not result.get("skipped"):
            logger.warning(
                "[MLflow Finalize] root span export failed: %s",
                result.get("error") or result,
            )
        return result
    except Exception as exc:  # noqa: BLE001
        logger.warning("[MLflow Finalize] unexpected failure: %s", exc)
        set_current_span_attrs({
            "mlflow.finalize.success": False,
            "mlflow.finalize.error": str(exc)[:500],
        })
        return {"success": False, "error": str(exc)}
