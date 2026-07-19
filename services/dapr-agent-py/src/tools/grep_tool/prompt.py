"""Prompt and constants for the Grep tool.

Adapted from kimi-code v2
packages/agent-core-v2/src/os/backends/node-local/tools/grep.md, adjusted for
the sandbox runtime (ripgrep executed inside the sandbox; no sensitive-file
filtering beyond the VCS directory exclusions).
"""

from ..bash_tool.prompt import BASH_TOOL_NAME

GREP_TOOL_NAME = "Grep"


def get_grep_tool_description() -> str:
    return f"""Search file contents using regular expressions (powered by ripgrep).

Use {GREP_TOOL_NAME} when the task is to find unknown content or unknown file locations. Do not use shell `grep` or `rg` directly; this tool applies workspace path policy and output limits.
ALWAYS use the {GREP_TOOL_NAME} tool instead of running `grep` or `rg` as a {BASH_TOOL_NAME} command — direct shell calls bypass workspace policy and output limits.
If you already know a concrete file path and need to inspect its contents, use Read directly instead.

Write patterns in ripgrep regex syntax, which differs from POSIX `grep` syntax. For example, braces are special, so escape them as `\\{{` to match a literal `{{`.

Usage:
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with the glob parameter (e.g., "*.js", "**/*.tsx") or the type parameter (e.g., "js", "py", "rust")
- Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count_matches" shows per-file match counts
- Multiline matching: by default patterns match within single lines only. For cross-line patterns like `struct \\{{[\\s\\S]*?field`, use multiline: true
- Hidden files (dotfiles such as `.gitlab-ci.yml` or `.eslintrc.json`) are searched by default. To also search files excluded by `.gitignore` (such as `node_modules` or build outputs), set include_ignored to true.
"""
