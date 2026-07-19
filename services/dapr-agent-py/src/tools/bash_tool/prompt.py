"""Prompt and constants for the Bash tool.

Originally ported from claude-code-src/main/tools/BashTool/prompt.ts; the
model-facing description is now aligned to Moonshot's kimi-code v2 Bash tool
(packages/agent-core-v2/src/os/backends/node-local/tools/bash.md), adapted for
our journaled Dapr runtime: no background execution, no cwd parameter, and a
timeout in seconds (default 60s, max 300s).
"""

from ..file_read.prompt import FILE_READ_TOOL_NAME
from ..file_write.prompt import FILE_WRITE_TOOL_NAME
from ..file_edit.prompt import FILE_EDIT_TOOL_NAME

BASH_TOOL_NAME = "Bash"

_DEFAULT_TIMEOUT_SECONDS = 60
_MAX_TIMEOUT_SECONDS = 300


def get_bash_tool_description() -> str:
    return f"""Execute a `bash` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.

**Translate these to a dedicated tool instead:**
- `cat` / `head` / `tail` (known path) → `{FILE_READ_TOOL_NAME}`
- `sed` / `awk` (in-place edit) → `{FILE_EDIT_TOOL_NAME}`
- `echo > file` / `cat <<EOF` → `{FILE_WRITE_TOOL_NAME}`
- `find` / recursive `ls` to locate files by name pattern → `Glob` (plain `ls <known-directory>` is fine for listing a directory)
- `grep` / `rg` (search file contents) → `Grep`
- `echo` / `printf` (talk to the user) → just output text directly

The dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.

**Output:**
The command's stdout and stderr are captured and returned as text, together with the exit code when it is non-zero. The output may be truncated if it is too long. If the command times out or fails to start, an error message is returned instead.

**Guidelines for safety and security:**
- Each shell tool call is executed in a fresh shell environment. Shell variables, working directory changes, and shell history are not preserved between calls. To run a command in a particular directory, use absolute paths (or chain with `&&`) rather than relying on a `cd` from an earlier call.
- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the `timeout` argument in seconds. The default is {_DEFAULT_TIMEOUT_SECONDS}s and the maximum is {_MAX_TIMEOUT_SECONDS}s; a command that hits its timeout is killed.
- Avoid using `..` to access files or directories outside of the working directory.
- Avoid modifying files outside of the working directory unless explicitly instructed to do so.
- Never run commands that require superuser privileges unless explicitly instructed to do so.

**Guidelines for efficiency:**
- Use `&&` to chain commands that genuinely depend on each other, e.g. `npm install && npm test`. Independent read-only commands (separate `git show`, `ls`, or status checks) should be issued as separate parallel {BASH_TOOL_NAME} calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with `echo` separators.
- Use `;` to run commands sequentially regardless of success/failure
- Use `||` for conditional execution (run second command only if first fails)
- Use pipe operations (`|`) and redirections (`>`, `>>`) to chain input and output between commands
- Always quote file paths containing spaces with double quotes (e.g., cd "/path with spaces/")
- Compose multi-step logic in a single call with `if` / `case` / `for` / `while` control flows.

**Commands available:**
The following common command categories are usually available. Availability still depends on the host, so when in doubt run `which <command>` first to confirm a command exists before relying on it.
- Navigation and inspection: `ls`, `pwd`, `cd`, `stat`, `file`, `du`, `df`, `tree`
- File and directory management: `cp`, `mv`, `rm`, `mkdir`, `touch`, `ln`, `chmod`, `chown`
- Text and data processing: `wc`, `sort`, `uniq`, `cut`, `tr`, `diff`, `xargs`
- Archives and compression: `tar`, `gzip`, `gunzip`, `zip`, `unzip`
- Networking and transfer: `curl`, `wget`, `ping`, `ssh`, `scp`
- Version control: `git`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the `gh` CLI when installed — it carries the user's GitHub auth and can return structured JSON
- Process and system: `ps`, `kill`, `top`, `env`, `date`, `uname`, `whoami`
- Language and package toolchains: `node`, `npm`, `pnpm`, `yarn`, `python`, `pip` (use whichever the project actually relies on)"""
