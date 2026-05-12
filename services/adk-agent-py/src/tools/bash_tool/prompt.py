"""Prompt and constants for the BashRun tool.

Ported from claude-code-src/main/tools/BashTool/prompt.ts (getSimplePrompt)
"""

from ..file_read.prompt import FILE_READ_TOOL_NAME
from ..file_write.prompt import FILE_WRITE_TOOL_NAME
from ..file_edit.prompt import FILE_EDIT_TOOL_NAME

BASH_TOOL_NAME = "Bash"

_DEFAULT_TIMEOUT_MS = 120_000
_MAX_TIMEOUT_MS = 600_000


def get_bash_tool_description() -> str:
    return f"""Executes a given bash command and returns its output.

The working directory persists between commands, but shell state does not.

IMPORTANT: Avoid using this tool to run `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:

 - File search: Use Glob (NOT find or ls)
 - Content search: Use Grep (NOT grep or rg)
 - Read files: Use {FILE_READ_TOOL_NAME} (NOT cat/head/tail)
 - Edit files: Use {FILE_EDIT_TOOL_NAME} (NOT sed/awk)
 - Write files: Use {FILE_WRITE_TOOL_NAME} (NOT echo >/cat <<EOF)

# Instructions
 - If your command will create new directories or files, first use this tool to run `ls` to verify the parent directory exists and is the correct location.
 - Try to maintain your current working directory throughout the session by using relative paths and avoiding usage of `cd`.
 - You may specify an optional timeout in milliseconds (up to {_MAX_TIMEOUT_MS}ms / {_MAX_TIMEOUT_MS // 60_000} minutes). By default, your command will timeout after {_DEFAULT_TIMEOUT_MS}ms ({_DEFAULT_TIMEOUT_MS // 60_000} minutes).
 - When issuing multiple commands:
   - If the commands are independent, make separate {BASH_TOOL_NAME} calls.
   - If the commands depend on each other and must run sequentially, use a single {BASH_TOOL_NAME} call with '&&' to chain them together.
   - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
   - DO NOT use newlines to separate commands (newlines are ok in quoted strings)."""
