"""Prompt and constants for the Glob tool.

Adapted from kimi-code v2
packages/agent-core-v2/src/os/backends/node-local/tools/glob.md, adjusted for
the sandbox runtime (pathlib-based matching: no brace expansion, no ignore-file
filtering; results sorted by modification time, most recent first).
"""

GLOB_TOOL_NAME = "Glob"


def get_glob_tool_description() -> str:
    return """Find files by glob pattern, sorted by modification time (most recent first).

Use this tool when you need to find files by name patterns. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. `**/fixtures/**`).

Good patterns:
- `**/*.py` — recursive walk from the search root for an extension
- `src/**/*.ts` — recursive walk with a subdirectory anchor and extension
- `src/*.ts` — files directly inside `src/` (one level, not recursive)

Results are capped at the first 100 matching paths. If a search would return more, a truncation marker is appended. Refine the pattern (extension, subdirectory) when 100 is not enough, or call again with a narrower anchor.

When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead."""
