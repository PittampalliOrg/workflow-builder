from __future__ import annotations

from typing import Any


def bounded_swebench_concurrency(value: Any, *, default: int = 1, maximum: int = 32) -> int:
    try:
        parsed = int(value or default)
    except (TypeError, ValueError):
        parsed = default
    return max(1, min(parsed, maximum))
