"""FileRead tool -- read files with line numbers, 1-based offset/tail support.

Ported from claude-code-src/main/tools/FileReadTool/FileReadTool.ts;
model-facing surface aligned with kimi-code v2's Read tool.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from src.openshell_runtime import get_runtime
from .._security import expand_path, is_binary_file, is_blocked_path
from .prompt import get_read_tool_description

_MAX_FILE_SIZE = 256 * 1024  # 256 KB soft limit
_MAX_LINES = 1000  # per-call line cap (kimi-code Read default)


class ReadArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    path: str = Field(
        description=(
            "Path to the text file to read. Relative paths resolve against the "
            "working directory; a path outside the working directory must be absolute."
        )
    )
    line_offset: int = Field(
        default=1,
        description=(
            "1-based line number to start reading from (default 1). Negative values "
            "read from the end of the file: -100 reads the last 100 lines."
        ),
    )
    n_lines: int = Field(
        default=_MAX_LINES,
        description=(
            f"Maximum number of lines to return, starting at line_offset "
            f"(default {_MAX_LINES}). Omit to read up to the {_MAX_LINES}-line cap."
        ),
    )


def file_read(path: str, line_offset: int = 1, n_lines: int = _MAX_LINES) -> str:
    # Check blocked paths before resolving (symlinks can hide the real path)
    if is_blocked_path(path):
        return f"Error: Access to '{path}' is blocked (device/pseudo-file)."

    resolved = expand_path(path)
    runtime = get_runtime()

    if is_blocked_path(resolved):
        return f"Error: Access to '{resolved}' is blocked (device/pseudo-file)."

    try:
        stat = runtime.stat_path(resolved)
    except Exception as exc:
        return f"Error reading file stats: {exc}"

    if not stat.get("ok"):
        return f"Error reading file stats: {stat.get('error') or stat}"

    if not stat.get("exists"):
        return f"Error: File not found: {resolved}"

    if stat.get("is_dir"):
        return (
            f"Error: '{resolved}' is a directory, not a file. Use Bash with 'ls' "
            f"to list a known directory, or Glob to find files by name pattern."
        )

    if is_binary_file(resolved):
        return f"Error: '{resolved}' appears to be a binary file and cannot be displayed as text."

    if n_lines < 1:
        return "Error: n_lines must be >= 1."

    # Size guard: refuse an unwindowed top-of-file read of a huge file; paged
    # reads (a line_offset window or a smaller n_lines) are fine.
    size = int(stat.get("size") or 0)

    if size > _MAX_FILE_SIZE and line_offset == 1 and n_lines >= _MAX_LINES:
        total_lines = _count_lines(resolved)
        return (
            f"Error: File '{resolved}' is {size:,} bytes ({total_lines} lines). "
            f"Use line_offset and n_lines to read specific portions "
            f"(e.g., line_offset=1, n_lines=100 for the first 100 lines)."
        )

    # kimi-code semantics: line_offset is 1-based; negative reads the tail.
    # The runtime backend takes a 0-based skip count.
    if line_offset < 0:
        total = _count_lines(resolved)
        skip = max(0, total + line_offset)
    else:
        skip = max(0, line_offset - 1)

    # Read with offset/limit
    try:
        result = runtime.read_file_lines(resolved, skip, n_lines)
        if not result.get("ok"):
            return f"Error reading file: {result.get('error') or result}"

        raw_lines = list(result.get("lines") or [])
        total_lines = int(result.get("total_lines") or 0)
        start_line = int(result.get("start_line") or 0)
        end_line = int(result.get("end_line") or 0)
        lines_out = [
            f"{line_no:>6}\t{line_text}"
            for line_no, line_text in enumerate(raw_lines, start=start_line)
        ]

        if not lines_out:
            if total_lines == 0:
                return f"File '{resolved}' is empty."
            return (
                f"No lines in range: line_offset={line_offset} is beyond the file's "
                f"{total_lines} lines."
            )

        content = "\n".join(lines_out)
        meta = f"(Read {len(lines_out)} lines, lines {start_line}-{end_line} of {total_lines} total)"
        return f"{content}\n{meta}"

    except Exception as exc:
        return f"Error reading file: {exc}"


def _count_lines(path: str) -> int:
    """Fast line count without loading entire file into memory."""
    try:
        result = get_runtime().read_file_lines(path, 0, 0)
    except Exception:
        return 0
    if not result.get("ok"):
        return 0
    return int(result.get("total_lines") or 0)


file_read.__doc__ = get_read_tool_description()
