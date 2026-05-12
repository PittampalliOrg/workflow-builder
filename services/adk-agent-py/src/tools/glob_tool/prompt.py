"""Prompt and constants for the GlobSearch tool.

Ported from claude-code-src/main/tools/GlobTool/prompt.ts
"""

GLOB_TOOL_NAME = "Glob"


def get_glob_tool_description() -> str:
    return """- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the agent_spawn tool instead"""
