"""Prompt and constants for the FileRead tool.

Aligned with kimi-code v2's Read tool description (read.md), adapted to the
dapr-agent-py sandbox runtime.
"""

FILE_READ_TOOL_NAME = "Read"


def get_read_tool_description() -> str:
    return """Read a text file from the local filesystem.

If the user provides a concrete file path to a text file, call Read directly. Do not `Glob`, `ls`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle. Do not use Read for directories; use `ls` via Bash for a known directory, or Glob when you need files matching a name pattern (Glob lists files only, never directories). Use `Grep` only when the task is to search for unknown content or locations.

When you need several files, prefer to read them in parallel: emit multiple `Read` calls in a single response instead of reading one file per turn.

- Relative paths resolve against the working directory; a path outside the working directory must be absolute.
- Returns up to 1000 lines per call by default.
- Page larger files with `line_offset` (1-based start line) and `n_lines`. Omit `n_lines` to read up to the 1000-line cap.
- Negative line_offset reads from the end of the file (for example, -100 reads the last 100 lines).
- Output format: `<line-number>\\t<content>` per line.
- A status line is appended after the file content; it summarizes how much was read (line counts and the file's total) and is not part of the file itself.
- After a successful `Edit`/`Write`, do not re-read solely to prove the write landed. When the task depends on an exact file, API, or output shape, inspect the final external contract before finishing."""
