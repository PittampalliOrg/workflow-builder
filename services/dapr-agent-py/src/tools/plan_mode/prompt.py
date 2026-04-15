"""Prompt and constants for the EnterPlanMode and ExitPlanMode tools.

Ported from claude-code-src/main/tools/EnterPlanModeTool/prompt.ts
and claude-code-src/main/tools/ExitPlanModeTool/prompt.ts
"""

ENTER_PLAN_MODE_TOOL_NAME = "enter_plan_mode"
EXIT_PLAN_MODE_TOOL_NAME = "exit_plan_mode"


def get_enter_plan_mode_description() -> str:
    return """Use this tool when you're about to start a non-trivial implementation task. Getting sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach.

When to use:
- New features requiring architectural decisions
- Changes spanning multiple files
- Tasks with multiple possible approaches
- When requirements are unclear and need exploration
- Multi-file changes (3+ files)

When NOT to use:
- Simple, single-line fixes or typo corrections
- Pure research or exploration tasks (just use read tools directly)
- Tasks where the exact approach is already specified

What happens:
- You enter READ-ONLY mode — only exploration tools are available
- Follow a 5-phase workflow: explore → design → review → write plan → submit
- Call exit_plan_mode with your complete plan when ready"""


def get_exit_plan_mode_description() -> str:
    return """Use this tool when you are in plan mode and have finished designing your plan. Pass your complete plan as the plan parameter.

Usage:
- You must be in plan mode (called enter_plan_mode first)
- Pass your complete implementation plan as the 'plan' parameter
- The plan should include: context, approach, files to modify, verification steps
- After calling this, you exit plan mode and all tools become available again

Important:
- Do NOT call this without a plan — always include the plan content
- The plan should be concise but detailed enough to execute"""
