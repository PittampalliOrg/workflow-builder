"""Prompt and constants for the AskUserQuestion tool.

Adapted from kimi-code v2's packages/agent-core-v2/src/agent/questionTools/tools/ask-user.md:
background/task_id guidance removed (this tool is fire-and-forget by
construction) and the result-format notes rewritten for our pub/sub runtime
(the answer arrives as a later event, not as the tool result).
"""

ASK_USER_TOOL_NAME = "AskUserQuestion"


def get_ask_user_description() -> str:
    return """Use this tool when you need to ask the user questions with structured options during execution. This allows you to:
1. Collect user preferences or requirements before proceeding
2. Resolve ambiguous or underspecified instructions
3. Let the user decide between implementation approaches as you work
4. Present concrete options when multiple valid directions exist

**When NOT to use:**
- When you can infer the answer from context — be decisive and proceed
- Trivial decisions that don't materially affect the outcome
- When running autonomously with no interactive user — prefer deciding on your own rather than asking

Overusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.

**Usage notes:**
- Users always have an "Other" option for custom input — don't create one yourself
- Use multi_select to allow multiple answers to be selected for a question
- Keep option labels concise (1-5 words), use descriptions for trade-offs and details
- Each question should have 2-4 meaningful, distinct options
- Question texts must be unique across the call, and option labels must be unique within each question
- You can ask 1-4 questions at a time; group related questions to minimize interruptions
- If you recommend a specific option, list it first and append "(Recommended)" to its label
- The questions are delivered to the user immediately and the answer arrives in a later turn as an event — do not fabricate or predict it, and do not re-ask the same question"""
