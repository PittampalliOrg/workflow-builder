from __future__ import annotations

from typing import Any


def is_swebench_execution_context(
    instance_id: str,
    context: dict[str, Any] | None,
) -> bool:
    """Return true for benchmark-owned SWE-bench workflow instances."""
    values = [instance_id]
    if isinstance(context, dict):
        values.extend(
            str(context.get(key) or "")
            for key in ("sessionId", "executionId", "workspaceRef")
        )
    for raw in values:
        value = str(raw or "").strip().lower()
        if value.startswith("sw-swebench-instance-exec-"):
            return True
        if "swebench-instance-exec" in value:
            return True
    return False
