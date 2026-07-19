"""GlobSearch tool -- file pattern matching sorted by modification time."""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from src.openshell_runtime import get_runtime
from .._security import expand_path
from .prompt import get_glob_tool_description

_MAX_RESULTS = 100


class GlobArgs(BaseModel):
    """Wire schema for the Glob tool (aligned with kimi-code v2 glob.ts)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    pattern: str = Field(
        description=(
            "Glob pattern to match files against, e.g. \"**/*.py\" or \"src/**/*.ts\". "
            "A pattern containing a directory anchor (e.g. \"src/**/*.ts\") walks that "
            "subdirectory of the search root."
        ),
    )
    path: str | None = Field(
        default=None,
        description=(
            "Directory to search in. Accepts an absolute path or a path relative to "
            "the current working directory. Omit to search the current working directory."
        ),
    )


def glob_search(pattern: str, path: str | None = None) -> str:
    """Search for files matching a glob pattern. Returns file paths sorted by modification time."""
    runtime = get_runtime()
    if path is not None:
        search_dir = expand_path(path)
        stat = runtime.stat_path(search_dir)
        if not stat.get("ok"):
            return f"Error: Directory not found: {search_dir}"
        if not stat.get("is_dir"):
            return f"Error: Directory not found: {search_dir}"
    else:
        search_dir = runtime.cwd

    display_pattern = pattern
    search_path = search_dir
    if pattern.startswith("/"):
        pattern_path = Path(pattern)
        parts = pattern_path.parts
        base_parts: list[str] = []
        glob_parts: list[str] = []
        found_glob = False
        for part in parts:
            if found_glob or any(c in part for c in "*?[{"):
                found_glob = True
                glob_parts.append(part)
            else:
                base_parts.append(part)
        if base_parts:
            search_path = str(Path(*base_parts)) if len(base_parts) > 1 else base_parts[0]
            pattern = str(Path(*glob_parts)) if glob_parts else "*"
        stat = runtime.stat_path(search_path)
        if not stat.get("is_dir"):
            return f"Error: Directory not found: {search_path}"

    try:
        result = runtime.glob_files(pattern, search_path, _MAX_RESULTS)
    except Exception as exc:
        return f"Error during glob search: {exc}"
    if not result.get("ok"):
        return f"Error during glob search: {result.get('error') or result}"

    files = list(result.get("matches") or [])
    total = int(result.get("total") or len(files))
    truncated = total > _MAX_RESULTS

    if not files:
        return f"No files found matching pattern '{display_pattern}' in {search_path}"

    lines = [str(f) for f in files]
    if truncated:
        lines.append(f"\n(Results truncated. Showing first {_MAX_RESULTS} of {total} matches.)")

    return "\n".join(lines)


glob_search.__doc__ = get_glob_tool_description()
