"""TodoList tool -- structured task tracking for the current agent run.

Storage reality: this service has no durable todo storage. The tool runs
inside the journaled ``run_tool`` Dapr activity, which may execute on any
worker/pod, so the list is kept in a minimal in-process store: a
module-level dict keyed by the current workflow instance id when one is
available (read from the same thread-local context the CallAgent tool
uses), falling back to a single process-wide bucket. The list is
best-effort scratch state for the model — it survives neither pod
restarts nor cross-pod activity scheduling, and the fallback bucket is
shared by all sessions on the pod.

Semantics match kimi-code v2's TodoList tool: omitting ``todos`` queries
the current list, ``todos: []`` clears it, otherwise the list is replaced
wholesale.
"""

from __future__ import annotations

import threading
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .._callable_agents_context import get_callable_agents_context
from .prompt import get_todo_list_description


class TodoItem(BaseModel):
    """A single todo entry."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(
        min_length=1,
        description="Short, actionable title for the task (e.g. \"Add planMode flag to TurnManager\").",
    )
    status: Literal["pending", "in_progress", "done"] = Field(
        description="Task status: 'pending', 'in_progress', or 'done'.",
    )


class TodoListArgs(BaseModel):
    """Wire schema for the TodoList tool."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    todos: list[TodoItem] | None = Field(
        default=None,
        description=(
            "The full replacement todo list. Omit to retrieve the current list "
            "without changing it; pass [] to clear the list; otherwise the "
            "current list is replaced with exactly these items."
        ),
    )


_VALID_STATUSES = {"pending", "in_progress", "done"}
_STATUS_ICONS = {"pending": "[ ]", "in_progress": "[~]", "done": "[x]"}

# In-process store, keyed by workflow instance id (see module docstring).
_store: dict[str, list[dict[str, str]]] = {}
_store_lock = threading.Lock()
_DEFAULT_BUCKET = "_default"


def _store_key() -> str:
    """Best-effort per-instance key; falls back to a process-wide bucket."""
    ctx = get_callable_agents_context()
    if ctx is not None:
        return ctx.parent_instance_id or ctx.parent_session_id or _DEFAULT_BUCKET
    return _DEFAULT_BUCKET


def _format(items: list[dict[str, str]]) -> str:
    lines = [f"{_STATUS_ICONS[item['status']]} {item['title']}" for item in items]
    done = sum(1 for item in items if item["status"] == "done")
    lines.append(f"\nProgress: {done}/{len(items)} done")
    return "\n".join(lines)


def todo_list(todos: list | None = None) -> str:
    """Maintain the session todo list. Omit todos to query, pass [] to clear, or pass the full replacement list."""
    key = _store_key()

    if todos is None:
        with _store_lock:
            current = [dict(item) for item in _store.get(key, [])]
        if not current:
            return "The todo list is empty."
        return _format(current)

    if not isinstance(todos, list):
        return (
            "Error: `todos` must be an array of {title, status} items. "
            "Omit it to query the current list or pass [] to clear it."
        )

    validated: list[dict[str, str]] = []
    for i, raw in enumerate(todos):
        item: Any = raw
        if isinstance(raw, TodoItem):
            item = {"title": raw.title, "status": raw.status}
        if not isinstance(item, dict):
            return f"Error: Item {i} is not an object with 'title' and 'status' fields."
        title = str(item.get("title") or "").strip()
        status = str(item.get("status") or "pending").strip().lower()
        if not title:
            return f"Error: Item {i} is missing a 'title' field."
        if status not in _VALID_STATUSES:
            return (
                f"Error: Item {i} has invalid status '{status}'. "
                f"Use: {', '.join(sorted(_VALID_STATUSES))}"
            )
        validated.append({"title": title, "status": status})

    with _store_lock:
        if validated:
            _store[key] = validated
        else:
            _store.pop(key, None)

    if not validated:
        return "The todo list has been cleared."
    return _format(validated)

todo_list.__doc__ = get_todo_list_description()
