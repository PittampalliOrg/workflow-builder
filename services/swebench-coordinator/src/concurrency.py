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


def instance_start_batch_size() -> int:
    return (
        _positive_int(os.environ.get("SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_SIZE"))
        or 10
    )


def instance_start_batch_delay_seconds() -> int:
    parsed = _non_negative_int(
        os.environ.get("SWEBENCH_COORDINATOR_INSTANCE_START_BATCH_DELAY_SECONDS")
    )
    return 5 if parsed is None else parsed


def bounded_swebench_concurrency(
    value: Any, *, default: int = 1, maximum: int | None = None
) -> int:
    parsed = _positive_int(value) or default
    cap = _positive_int(maximum) or max_inference_concurrency()
    return max(1, min(parsed, cap))


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
