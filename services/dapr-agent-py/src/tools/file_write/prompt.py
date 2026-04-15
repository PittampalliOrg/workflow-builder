"""Prompt and constants for the FileWrite tool.

Ported from claude-code-src/main/tools/FileWriteTool/prompt.ts
"""

from ..file_read.prompt import FILE_READ_TOOL_NAME

FILE_WRITE_TOOL_NAME = "Write"


def get_write_tool_description() -> str:
    return f"""Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the {FILE_READ_TOOL_NAME} tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the file_edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked."""
