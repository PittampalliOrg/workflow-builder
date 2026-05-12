"""FileRead tool -- read files with line numbers, offset/limit support.

Ported from claude-code-src/main/tools/FileReadTool/FileReadTool.ts
"""

from __future__ import annotations

from src.openshell_runtime import get_runtime
from .._security import expand_path, is_binary_file, is_blocked_path
from .prompt import get_read_tool_description

_MAX_FILE_SIZE = 256 * 1024  # 256 KB soft limit


def file_read(file_path: str, offset: int = 0, limit: int = 2000) -> str:
    # Check blocked paths before resolving (symlinks can hide the real path)
    if is_blocked_path(file_path):
        return f"Error: Access to '{file_path}' is blocked (device/pseudo-file)."

    resolved = expand_path(file_path)
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
        return f"Error: '{resolved}' is a directory, not a file. Use glob_search to list directory contents."

    if is_binary_file(resolved):
        return f"Error: '{resolved}' appears to be a binary file and cannot be displayed as text."

    # Size guard
    size = int(stat.get("size") or 0)

    if size > _MAX_FILE_SIZE and limit >= 2000:
        total_lines = _count_lines(resolved)
        return (
            f"Error: File '{resolved}' is {size:,} bytes ({total_lines} lines). "
            f"Use offset and limit parameters to read specific portions "
            f"(e.g., offset=0, limit=100 for the first 100 lines)."
        )

    # Read with offset/limit
    try:
        result = runtime.read_file_lines(resolved, offset, limit)
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
                f"No lines in range: offset={offset} is beyond the file's "
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
