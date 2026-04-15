"""Prompt and constants for the FileRead tool.

Ported from claude-code-src/main/tools/FileReadTool/prompt.ts
"""

FILE_READ_TOOL_NAME = "Read"


def get_read_tool_description() -> str:
    return """Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- By default, it reads up to 2000 lines starting from the beginning of the file.
- When you already know which part of the file you need, only read that part. This can be important for larger files.
- Results are returned using cat -n format, with line numbers starting at 1.
- This tool can only read files, not directories. To read a directory, use bash_run with 'ls'.
- If you read a file that exists but has empty contents you will receive a warning."""
