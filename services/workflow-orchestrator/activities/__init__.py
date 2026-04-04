"""
Activities for the workflow orchestrator.

Activities are **auto-discovered** at import time by scanning every Python module
in this package.  A function is considered an activity if it:

  1. Is public (no leading underscore)
  2. Is a plain function (not a class)
  3. Has exactly 2 parameters (ctx, input_data)

To add a new activity, just create a function matching that signature in any
module under this package.  It will be registered with both the Dapr workflow
runtime and the introspection endpoint automatically — no other file needs to
change.
"""

from __future__ import annotations

import importlib
import inspect
import pkgutil
from pathlib import Path
from typing import Any, Callable

# Re-export for direct import by app.py or other consumers.
from .execute_action import ExecuteActionInput  # noqa: F401
from .call_agent_service import terminate_durable_runs_by_parent_execution  # noqa: F401


def _is_activity(obj: Any, module_name: str) -> bool:
    """Return True if *obj* looks like a Dapr workflow activity function."""
    if not callable(obj) or not inspect.isfunction(obj):
        return False
    if obj.__name__.startswith("_"):
        return False
    # Must be defined in this activities package, not imported from elsewhere
    if not getattr(obj, "__module__", "").startswith(module_name):
        return False
    params = inspect.signature(obj).parameters
    return len(params) == 2


def _discover_activities() -> list[Callable]:
    """Import every module in this package and collect activity functions."""
    pkg_dir = Path(__file__).resolve().parent
    activities: list[Callable] = []
    seen: set[str] = set()

    pkg_name = __name__  # "activities"
    for info in pkgutil.iter_modules([str(pkg_dir)]):
        mod = importlib.import_module(f".{info.name}", package=pkg_name)
        for name in dir(mod):
            obj = getattr(mod, name)
            if _is_activity(obj, pkg_name) and name not in seen:
                seen.add(name)
                activities.append(obj)

    return activities


ACTIVITIES: list[Callable] = _discover_activities()

__all__ = [fn.__name__ for fn in ACTIVITIES] + [
    "ACTIVITIES",
    "ExecuteActionInput",
    "terminate_durable_runs_by_parent_execution",
]
