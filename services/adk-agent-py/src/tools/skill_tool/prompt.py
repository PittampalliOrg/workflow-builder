"""Prompt and constants for the Skill tool.

Ported from claude-code-src/main/tools/SkillTool/prompt.ts.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import SkillDefinition

SKILL_TOOL_NAME = "Skill"

# Skill listing budget -- mirrors Claude Code's 1% of context window.
# Default character budget when context window size is unknown.
DEFAULT_LISTING_CHAR_BUDGET = 8_000
MAX_LISTING_DESC_CHARS = 250


def get_skill_tool_description() -> str:
    """Return the tool description shown to the model.

    Mirrors ``getPrompt()`` from claude-code-src/main/tools/SkillTool/prompt.ts.
    """
    return """Execute a skill within the main conversation.

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - skill: "pdf" - invoke the pdf skill
  - skill: "commit", args: "-m 'Fix bug'" - invoke with arguments
  - skill: "review-pr", args: "123" - invoke with arguments

Important:
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
"""


# ---------------------------------------------------------------------------
# Skill listing formatter
# ---------------------------------------------------------------------------


def _format_entry(skill: "SkillDefinition") -> str:
    """Format a single skill for the listing."""
    desc = skill.description
    if skill.when_to_use:
        desc = f"{desc} - {skill.when_to_use}"
    if len(desc) > MAX_LISTING_DESC_CHARS:
        desc = desc[: MAX_LISTING_DESC_CHARS - 1] + "\u2026"
    return f"- {skill.name}: {desc}"


def format_skill_listings(
    skills: list["SkillDefinition"],
    max_chars: int = DEFAULT_LISTING_CHAR_BUDGET,
) -> str:
    """Format available skills for injection into the system prompt.

    Mirrors ``formatCommandsWithinBudget()`` from
    ``claude-code-src/main/tools/SkillTool/prompt.ts``.

    Returns an empty string when there are no skills to list.
    """
    if not skills:
        return ""

    entries = [_format_entry(s) for s in skills]
    body = "\n".join(entries)

    # Truncate non-bundled entries if over budget (simple version:
    # truncate individual descriptions to fit within the budget).
    if len(body) > max_chars:
        # Try name-only for non-bundled entries
        short_entries: list[str] = []
        for s in skills:
            if s.source == "bundled":
                short_entries.append(_format_entry(s))
            else:
                short_entries.append(f"- {s.name}")
        body = "\n".join(short_entries)
        if len(body) > max_chars:
            body = body[:max_chars] + "\n... (truncated)"

    header = (
        "The following skills are available for use with the Skill tool:\n\n"
    )
    return f"<system-reminder>\n{header}{body}\n</system-reminder>"
