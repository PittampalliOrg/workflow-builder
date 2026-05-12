"""Prompt and constants for the TaskStop tool.

Ported from claude-code-src/main/tools/TaskStopTool/prompt.ts
"""

TASK_STOP_TOOL_NAME = "task_stop"


def get_task_stop_description() -> str:
    return """- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task"""
