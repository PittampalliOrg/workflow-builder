"""Best-effort MLflow workflow-node span activity."""

from __future__ import annotations

import logging
from typing import Any

from tracing import emit_mlflow_workflow_node_span, set_current_span_attrs

logger = logging.getLogger(__name__)


def emit_mlflow_node_span(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Emit a synthetic OTLP child span for one completed workflow node."""
    _ = ctx
    input_data = input_data or {}

    set_current_span_attrs({
        "workflow.id": input_data.get("workflowId"),
        "workflow.name": input_data.get("workflowName"),
        "workflow.execution.id": input_data.get("executionId"),
        "workflow.execution.db_id": input_data.get("dbExecutionId"),
        "workflow.instance_id": input_data.get("daprInstanceId")
        or input_data.get("workflowInstanceId"),
        "workflow.node.id": input_data.get("nodeId"),
        "workflow.node.name": input_data.get("nodeName"),
        "workflow.node.type": input_data.get("nodeType"),
        "workflow.node.status": input_data.get("status"),
        "workflow.node.duration_ms": input_data.get("durationMs"),
        "mlflow.trace_id": input_data.get("traceId"),
    })

    try:
        result = emit_mlflow_workflow_node_span(input_data)
        set_current_span_attrs({
            "mlflow.node_span.success": bool(result.get("success")),
            "mlflow.node_span.skipped": bool(result.get("skipped")),
            "mlflow.node_span.skip_reason": result.get("reason"),
            "mlflow.node_span.error": (result.get("error") or "")[:500]
            if result.get("error")
            else None,
        })
        if not result.get("success") and not result.get("skipped"):
            logger.warning(
                "[MLflow Node Span] export failed: %s",
                result.get("error") or result,
            )
        return result
    except Exception as exc:  # noqa: BLE001
        logger.warning("[MLflow Node Span] unexpected failure: %s", exc)
        set_current_span_attrs({
            "mlflow.node_span.success": False,
            "mlflow.node_span.error": str(exc)[:500],
        })
        return {"success": False, "error": str(exc)}
