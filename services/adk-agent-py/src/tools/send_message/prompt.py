"""Prompt and constants for the SendMessage tool.

Ported from claude-code-src/main/tools/SendMessageTool/prompt.ts (simplified)
"""

SEND_MESSAGE_TOOL_NAME = "send_message"


def get_send_message_description() -> str:
    return """Send a message or status update to the user or another agent.

Usage:
- Use to broadcast progress updates during long-running tasks
- Use to notify the user of important state changes
- Messages are delivered via pub/sub and may not require a response"""
