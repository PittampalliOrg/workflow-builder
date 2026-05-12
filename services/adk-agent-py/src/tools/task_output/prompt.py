"""Prompt and constants for the TaskOutput tool.

No prompt.ts exists in claude-code-src; constants from TaskOutputTool/constants.ts
"""

TASK_OUTPUT_TOOL_NAME = "task_output"


def get_task_output_description() -> str:
    return """Get the output of a background task or workflow instance by its ID.

- Takes a task_id parameter identifying the task to query
- Returns the task's output, messages, and status
- Use this tool when you need to check the result of a previously spawned agent or background task"""
