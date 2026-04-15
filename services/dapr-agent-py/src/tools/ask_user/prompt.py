"""Prompt and constants for the AskUser tool.

Ported from claude-code-src/main/tools/AskUserQuestionTool/prompt.ts
"""

ASK_USER_TOOL_NAME = "ask_user"


def get_ask_user_description() -> str:
    return """Asks the user a question to gather information, clarify ambiguity, understand preferences, make decisions, or offer them choices.

Usage:
- Use this tool when you need to gather user preferences or decisions
- Use when clarifying ambiguous requirements before proceeding
- Use when offering the user a choice between approaches
- The question should be clear and specific"""
