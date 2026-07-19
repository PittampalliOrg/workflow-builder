"""FileWrite tool -- create, overwrite, or append to files.

Ported from claude-code-src/main/tools/FileWriteTool/FileWriteTool.ts;
model-facing surface aligned with kimi-code v2's Write tool.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from src.openshell_runtime import get_runtime
from .._security import expand_path
from .prompt import get_write_tool_description


class WriteArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    path: str = Field(
        description=(
            "Path of the file to write. Relative paths resolve against the working "
            "directory; missing parent directories are created automatically."
        )
    )
    content: str = Field(
        description=(
            "The exact content to write. Output is literal, including supplied line "
            "endings: \\n stays LF, \\r\\n stays CRLF. Never include line-number prefixes."
        )
    )
    mode: Literal["overwrite", "append"] = Field(
        default="overwrite",
        description=(
            "'overwrite' (default) replaces the file entirely; 'append' adds content "
            "at EOF without adding a newline."
        ),
    )


def file_write(path: str, content: str, mode: str = "overwrite") -> str:
    if mode not in ("overwrite", "append"):
        return f"Error: mode must be 'overwrite' or 'append', got '{mode}'."

    resolved = expand_path(path)
    runtime = get_runtime()

    # The runtime backends only offer whole-file writes; append is read-then-write.
    if mode == "append":
        try:
            stat = runtime.stat_path(resolved)
        except Exception as exc:
            return f"Error reading file stats: {exc}"
        if not stat.get("ok"):
            return f"Error reading file stats: {stat.get('error') or stat}"
        if stat.get("is_dir"):
            return f"Error: '{resolved}' is a directory, not a file."
        if stat.get("exists"):
            try:
                read_result = runtime.read_text(resolved)
            except Exception as exc:
                return f"Error reading file: {exc}"
            if not read_result.get("ok"):
                return f"Error reading file: {read_result.get('error') or read_result}"
            content = str(read_result.get("content") or "") + content

    try:
        result = runtime.write_text(resolved, content)
    except Exception as exc:
        return f"Error writing file: {exc}"
    if not result.get("ok"):
        return f"Error writing file: {result.get('error') or result}"

    action = "updated" if result.get("existed") else "created"

    line_count = content.count("\n") + (1 if content and not content.endswith("\n") else 0)
    return f"Successfully wrote {line_count} lines to {resolved} ({action})"


file_write.__doc__ = get_write_tool_description()
