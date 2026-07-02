"""Compatibility no-op for the retired workflow-node span activity."""

from __future__ import annotations

from typing import Any


def emit_mlflow_node_span(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    """Preserve old activity histories without exporting to a retired backend."""
    _ = ctx, input_data
    return {"success": True, "skipped": True, "reason": "retired"}
