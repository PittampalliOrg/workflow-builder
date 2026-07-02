"""Compatibility shim for the retired MLflow finalizer activity name."""

from __future__ import annotations

from typing import Any

from activities.finalize_otel_trace_root import (
    _fetch_trace_targets,
    _record_lineage_links,
    finalize_otel_trace_root,
)


def finalize_mlflow_trace_root(ctx, input_data: dict[str, Any]) -> dict[str, Any]:
    return finalize_otel_trace_root(ctx, input_data)


_fetch_mlflow_run_targets = _fetch_trace_targets
