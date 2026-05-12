"""TodoWrite tool -- task tracking list stored in workflow state."""

from __future__ import annotations

import json


def todo_write(todos: str) -> str:
    """Write or update a task tracking list. Pass a JSON array of todo items with task and status fields."""
    if not todos or not todos.strip():
        return "Error: No todos provided. Expected a JSON array of {task, status} objects."

    try:
        items = json.loads(todos)
    except json.JSONDecodeError as exc:
        return f"Error: Invalid JSON: {exc}"

    if not isinstance(items, list):
        return "Error: Expected a JSON array of todo items."

    valid_statuses = {"pending", "in_progress", "completed"}
    validated: list[dict] = []

    for i, item in enumerate(items):
        if not isinstance(item, dict):
            return f"Error: Item {i} is not an object."
        task = item.get("task", "").strip()
        status = item.get("status", "pending").strip().lower()
        if not task:
            return f"Error: Item {i} is missing a 'task' field."
        if status not in valid_statuses:
            return f"Error: Item {i} has invalid status '{status}'. Use: {', '.join(sorted(valid_statuses))}"
        validated.append({"task": task, "status": status})

    # Format output
    status_icons = {"pending": "[ ]", "in_progress": "[~]", "completed": "[x]"}
    lines: list[str] = []
    for item in validated:
        icon = status_icons[item["status"]]
        lines.append(f"{icon} {item['task']}")

    completed = sum(1 for item in validated if item["status"] == "completed")
    total = len(validated)
    lines.append(f"\nProgress: {completed}/{total} completed")

    return "\n".join(lines)

from .prompt import get_todo_write_description
todo_write.__doc__ = get_todo_write_description()
