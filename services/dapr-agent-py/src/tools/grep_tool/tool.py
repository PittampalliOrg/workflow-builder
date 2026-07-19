"""GrepSearch tool -- regex content search via ripgrep."""

from __future__ import annotations

import shlex
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from src.openshell_runtime import get_runtime
from .._security import expand_path
from .prompt import get_grep_tool_description

_VCS_DIRS = (".git", ".svn", ".hg", ".bzr", ".jj", ".sl")
_DEFAULT_TIMEOUT = 30  # seconds


class GrepArgs(BaseModel):
    """Wire schema for the Grep tool (aligned with kimi-code v2 grep.ts)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    pattern: str = Field(
        description=(
            "Regular expression to search for, in ripgrep syntax (not POSIX grep "
            "syntax). Braces are special — escape them as \\{ to match a literal '{'."
        ),
    )
    path: str | None = Field(
        default=None,
        description=(
            "File or directory to search in. Defaults to the current working directory."
        ),
    )
    glob: str | None = Field(
        default=None,
        description=(
            "Glob filter for which files to search, e.g. \"*.py\" or \"**/*.tsx\". "
            "Matched against each file's full path."
        ),
    )
    type: str | None = Field(
        default=None,
        description=(
            "Ripgrep file type filter, such as \"py\" or \"rust\". More efficient and "
            "less error-prone than an equivalent glob pattern."
        ),
    )
    output_mode: Literal["content", "files_with_matches", "count_matches"] = Field(
        default="files_with_matches",
        description=(
            "\"content\" shows matching lines (honors -n, -A, -B, -C, offset and "
            "head_limit), \"files_with_matches\" shows only the paths of files that "
            "contain a match, \"count_matches\" shows per-file match counts as "
            "path:count lines."
        ),
    )
    i: bool = Field(
        default=False,
        alias="-i",
        description="Perform a case-insensitive search.",
    )
    n: bool = Field(
        default=True,
        alias="-n",
        description=(
            "Prefix each matching line with its line number. Applies only when "
            "output_mode is \"content\"."
        ),
    )
    A: int | None = Field(
        default=None,
        alias="-A",
        description=(
            "Number of lines to show after each match. Applies only when output_mode "
            "is \"content\"."
        ),
    )
    B: int | None = Field(
        default=None,
        alias="-B",
        description=(
            "Number of lines to show before each match. Applies only when output_mode "
            "is \"content\"."
        ),
    )
    C: int | None = Field(
        default=None,
        alias="-C",
        description=(
            "Number of lines to show before and after each match. Applies only when "
            "output_mode is \"content\"; takes precedence over -A and -B."
        ),
    )
    head_limit: int = Field(
        default=250,
        description=(
            "Limit output to the first N lines after offset. Pass 0 for unlimited output."
        ),
    )
    offset: int = Field(
        default=0,
        description=(
            "Number of leading lines to skip before applying head_limit. Use together "
            "with head_limit to page through large result sets."
        ),
    )
    multiline: bool = Field(
        default=False,
        description=(
            "Enable multiline matching, where the pattern can span line boundaries and "
            "'.' also matches newlines."
        ),
    )
    include_ignored: bool = Field(
        default=False,
        description=(
            "Also search files excluded by ignore files such as .gitignore (for "
            "example node_modules or build outputs) and skip the built-in VCS "
            "metadata directory exclusions."
        ),
    )


def grep_search(
    pattern: str,
    path: str | None = None,
    glob: str | None = None,
    type: str | None = None,
    output_mode: str = "files_with_matches",
    i: bool = False,
    n: bool = True,
    A: int | None = None,
    B: int | None = None,
    C: int | None = None,
    head_limit: int = 250,
    offset: int = 0,
    multiline: bool = False,
    include_ignored: bool = False,
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

    if include_ignored:
        args.append("--no-ignore")
    else:
        # Exclude VCS metadata directories
        for vcs in _VCS_DIRS:
            args.extend(["--glob", f"!{vcs}"])

    # Max column width to avoid huge binary lines
    args.extend(["--max-columns", "500"])

    # Multiline mode
    if multiline:
        args.extend(["-U", "--multiline-dotall"])

    # Case sensitivity
    if i:
        args.append("-i")

    # Output mode
    if output_mode == "files_with_matches":
        args.append("-l")
    elif output_mode == "count_matches":
        args.append("-c")
    # else: content mode (default rg behavior)

    # Line numbers (content mode only)
    if output_mode == "content" and n:
        args.append("-n")

    # Context lines (content mode only); -C takes precedence over -A/-B
    if output_mode == "content":
        if C is not None:
            args.extend(["-C", str(C)])
        else:
            if B is not None:
                args.extend(["-B", str(B)])
            if A is not None:
                args.extend(["-A", str(A)])

    # Pattern (prefix with -e if starts with -)
    if pattern.startswith("-"):
        args.extend(["-e", pattern])
    else:
        args.append(pattern)

    # Type filter
    if type:
        args.extend(["--type", type])

    # Glob filter
    if glob:
        # Handle brace patterns vs comma-separated
        patterns: list[str] = []
        for raw in glob.split():
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

    if head_limit > 0:
        truncated = len(lines) > head_limit
        lines = lines[:head_limit]
    else:
        truncated = False

    output = "\n".join(lines)
    if truncated:
        output += f"\n\n(Results truncated at {head_limit} lines. Use offset to see more.)"

    return output


grep_search.__doc__ = get_grep_tool_description()
