"""FileWrite tool -- create or overwrite files.

Ported from claude-code-src/main/tools/FileWriteTool/FileWriteTool.ts
"""

from __future__ import annotations

from src.openshell_runtime import get_runtime
from .._security import expand_path
from .prompt import get_write_tool_description


def file_write(file_path: str, content: str) -> str:
    resolved = expand_path(file_path)

    try:
        result = get_runtime().write_text(resolved, content)
    except Exception as exc:
        return f"Error writing file: {exc}"
    if not result.get("ok"):
        return f"Error writing file: {result.get('error') or result}"

    action = "updated" if result.get("existed") else "created"

    line_count = content.count("\n") + (1 if content and not content.endswith("\n") else 0)
    return f"Successfully wrote {line_count} lines to {resolved} ({action})"


file_write.__doc__ = get_write_tool_description()
