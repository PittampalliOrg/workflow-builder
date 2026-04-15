"""Data models for the skills system.

Ported from claude-code-src/main/skills/bundledSkills.ts (BundledSkillDefinition)
and claude-code-src/main/skills/loadSkillsDir.ts (FrontmatterData / PromptCommand).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SkillDefinition:
    """A resolved skill definition from any source.

    Mirrors Claude Code's ``Command`` (type='prompt') with the subset of
    fields relevant to dapr-agent-py.  The ``prompt`` field holds the
    markdown body that gets expanded inline when the Skill tool is invoked.
    """

    name: str
    description: str
    prompt: str  # Markdown body after frontmatter
    source: str  # "bundled" | "disk" | "agentConfig"
    when_to_use: str = ""
    allowed_tools: tuple[str, ...] = ()  # Empty = all tools allowed
    arguments: tuple[str, ...] = ()  # Named argument descriptors
    argument_hint: str = ""  # Hint text (e.g. "<pr-number>")
    model_override: str = ""  # Future: per-skill model routing
    user_invocable: bool = True
    disable_model_invocation: bool = False
