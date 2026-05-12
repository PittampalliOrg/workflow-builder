"""Prompt and constants for the TodoWrite tool.

Ported from claude-code-src/main/tools/TodoWriteTool/prompt.ts
"""

TODO_WRITE_TOOL_NAME = "todo_write"


def get_todo_write_description() -> str:
    return """Update the todo list for the current session. To be used proactively and often to track progress and pending tasks.

Usage:
- Pass a JSON array of todo items, each with 'task' (string) and 'status' ('pending', 'in_progress', or 'completed') fields.
- Keep at least one task in_progress at all times during active work.
- Use for multi-step tasks, complex operations, or when asked to track progress.
- Do NOT use for single, simple operations that complete in one step."""
