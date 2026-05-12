"""Best-effort MLflow trace finalization activity."""

from __future__ import annotations

import logging
from typing import Any

from tracing import emit_mlflow_trace_root_span

logger = logging.getLogger(__name__)


def finalize_mlflow_trace_root(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Emit a synthetic OTLP root span for the workflow's existing trace ID."""
    _ = ctx
    try:
        result = emit_mlflow_trace_root_span(input_data or {})
        if not result.get("success") and not result.get("skipped"):
            logger.warning(
                "[MLflow Finalize] root span export failed: %s",
                result.get("error") or result,
            )
        return result
    except Exception as exc:  # noqa: BLE001
        logger.warning("[MLflow Finalize] unexpected failure: %s", exc)
        return {"success": False, "error": str(exc)}
