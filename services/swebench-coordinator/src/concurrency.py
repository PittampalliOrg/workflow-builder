from __future__ import annotations

import os
from typing import Any


DEFAULT_MAX_INFERENCE_CONCURRENCY = 56
DEFAULT_EVALUATION_CONCURRENCY = 24


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _non_negative_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def max_inference_concurrency() -> int:
    return _positive_int(
        os.environ.get("SWEBENCH_COORDINATOR_MAX_INFERENCE_CONCURRENCY")
    ) or DEFAULT_MAX_INFERENCE_CONCURRENCY


def instance_start_batch_size(concurrency: Any = None) -> int:
    """Return the launch burst size for a SWE-bench run.

    A missing or non-positive env value means "burst up to the run's computed
    concurrency". Positive env values remain available for diagnostic pacing.
    """

    configured = _positive_int(
        os.environ.get("SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_SIZE")
    )
    if configured is not None:
        return configured
    return _positive_int(concurrency) or 1


def instance_start_batch_delay_seconds() -> int:
    parsed = _non_negative_int(
        os.environ.get("SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_DELAY_SECONDS")
    )
    return 0 if parsed is None else parsed


def bounded_swebench_concurrency(
    value: Any, *, default: int = 1, maximum: int | None = None
) -> int:
    parsed = _positive_int(value) or default
    cap = _positive_int(maximum) or max_inference_concurrency()
    return max(1, min(parsed, cap))


def _capacity_snapshot(run: dict[str, Any]) -> dict[str, Any]:
    summary = run.get("summary") if isinstance(run.get("summary"), dict) else {}
    capacity = summary.get("capacity") if isinstance(summary, dict) else None
    return capacity if isinstance(capacity, dict) else {}


def bounded_swebench_run_concurrency(run: dict[str, Any]) -> int:
    """Use the BFF capacity snapshot as the source of truth for fan-out.

    The coordinator still honors SWEBENCH_COORDINATOR_MAX_INFERENCE_CONCURRENCY
    when explicitly configured, but it should not impose its historical default
    cap after the BFF has already computed runtime, Dapr, sandbox, and model
    capacity for the run.
    """

    capacity = _capacity_snapshot(run)
    candidates = [
        _positive_int(run.get("concurrency")),
        _positive_int(capacity.get("effectiveConcurrency")),
        _positive_int(capacity.get("maxActiveInferenceInstances")),
        _positive_int(os.environ.get("SWEBENCH_COORDINATOR_MAX_INFERENCE_CONCURRENCY")),
    ]
    selected = [candidate for candidate in candidates if candidate is not None]
    if not selected:
        return 1
    return max(1, min(selected))


def bounded_swebench_evaluation_concurrency(
    value: Any,
    *,
    default: int = DEFAULT_EVALUATION_CONCURRENCY,
    maximum: int = 128,
) -> int:
    try:
        parsed = int(value or default)
    except (TypeError, ValueError):
        parsed = default
    return max(1, min(parsed, maximum))
