"""GrepSearch tool -- regex content search via ripgrep."""

from __future__ import annotations

import shlex

from src.openshell_runtime import get_runtime
from .._security import expand_path

_VCS_DIRS = (".git", ".svn", ".hg", ".bzr", ".jj", ".sl")
_DEFAULT_TIMEOUT = 30  # seconds
_DEFAULT_HEAD_LIMIT = 250


def grep_search(
    pattern: str,
    path: str | None = None,
    include: str | None = None,
    output_mode: str = "files_with_matches",
    context_before: int | None = None,
    context_after: int | None = None,
    context: int | None = None,
    case_insensitive: bool = False,
    file_type: str | None = None,
    head_limit: int = 250,
    offset: int = 0,
    multiline: bool = False,
) -> str:
    """Search file contents using regex patterns (powered by ripgrep). Supports context lines, file type filters, and multiple output modes."""
    runtime = get_runtime()
    if path is not None:
        search_dir = expand_path(path)
        stat = runtime.stat_path(search_dir)
        if not stat.get("ok") or not stat.get("exists"):
            return f"Error: Path not found: {search_dir}"
    else:
        search_dir = runtime.cwd

    # Build ripgrep arguments
    args: list[str] = ["rg", "--hidden"]

    # Exclude VCS directories
    for vcs in _VCS_DIRS:
        args.extend(["--glob", f"!{vcs}"])

    # Max column width to avoid huge binary lines
    args.extend(["--max-columns", "500"])

    # Multiline mode
    if multiline:
        args.extend(["-U", "--multiline-dotall"])

    # Case sensitivity
    if case_insensitive:
        args.append("-i")

    # Output mode
    if output_mode == "files_with_matches":
        args.append("-l")
    elif output_mode == "count":
        args.append("-c")
    # else: content mode (default rg behavior)

    # Line numbers (content mode only)
    if output_mode == "content":
        args.append("-n")

    # Context lines (content mode only)
    if output_mode == "content":
        if context is not None:
            args.extend(["-C", str(context)])
        else:
            if context_before is not None:
                args.extend(["-B", str(context_before)])
            if context_after is not None:
                args.extend(["-A", str(context_after)])

    # Pattern (prefix with -e if starts with -)
    if pattern.startswith("-"):
        args.extend(["-e", pattern])
    else:
        args.append(pattern)

    # Type filter
    if file_type:
        args.extend(["--type", file_type])

    # Glob include filter
    if include:
        # Handle brace patterns vs comma-separated
        patterns: list[str] = []
        for raw in include.split():
            if "{" in raw and "}" in raw:
                patterns.append(raw)
            else:
                patterns.extend(raw.split(","))
        for glob_pat in patterns:
            glob_pat = glob_pat.strip()
            if glob_pat:
                args.extend(["--glob", glob_pat])

    # Search path
    args.append(search_dir)

    try:
        result = runtime.execute(shlex.join(args), timeout_seconds=_DEFAULT_TIMEOUT)
    except Exception as exc:
        return f"Error: ripgrep error: {exc}"

    # rg exit codes: 0 = matches found, 1 = no matches, 2 = error
    exit_code = int(result.get("exit_code") or 0)
    stdout = str(result.get("stdout") or "")
    stderr = str(result.get("stderr") or "")
    if exit_code == 127:
        return (
            "Error: ripgrep (rg) is not installed. "
            "Install it with: apt-get install ripgrep"
        )
    if exit_code == 2:
        return f"Error: ripgrep error: {stderr}"

    if exit_code == 1 or not stdout.strip():
        return "No matches found."

    # Apply offset and head_limit
    lines = stdout.rstrip("\n").split("\n")

    if offset > 0:
        lines = lines[offset:]

    effective_limit = head_limit if head_limit > 0 else _DEFAULT_HEAD_LIMIT
    truncated = len(lines) > effective_limit
    lines = lines[:effective_limit]

    output = "\n".join(lines)
    if truncated:
        output += f"\n\n(Results truncated at {effective_limit} lines. Use offset to see more.)"

    return output

from .prompt import get_grep_tool_description
grep_search.__doc__ = get_grep_tool_description()
