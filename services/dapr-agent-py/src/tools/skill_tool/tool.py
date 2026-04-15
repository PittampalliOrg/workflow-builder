"""RunSkill tool -- execute registered skills by name.

Ported from claude-code-src/main/tools/SkillTool/SkillTool.ts.

Skills are resolved from three tiers (highest priority first):
  1. **instance** — per-workflow skills from ``agentConfig.skills``
  2. **disk** — loaded from ``SKILL.md`` files at startup
  3. **bundled** — registered programmatically via ``register_skill()``

When invoked the tool performs *inline expansion*: the skill's prompt
(with ``${ARGUMENTS}`` substitution) is returned as the tool result so
the LLM reads and follows the instructions.
"""

from __future__ import annotations

import logging
import threading
from typing import Callable

from .models import SkillDefinition

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# SkillRegistry
# ---------------------------------------------------------------------------


class SkillRegistry:
    """Thread-safe registry holding skills from all sources."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._bundled: dict[str, SkillDefinition] = {}
        self._disk: dict[str, SkillDefinition] = {}
        self._instance: dict[str, SkillDefinition] = {}

    # -- mutation -----------------------------------------------------------

    def register_bundled(self, skill: SkillDefinition) -> None:
        with self._lock:
            self._bundled[skill.name] = skill

    def set_disk_skills(self, skills: list[SkillDefinition]) -> None:
        with self._lock:
            self._disk = {s.name: s for s in skills}

    def set_instance_skills(self, skills: list[SkillDefinition]) -> None:
        with self._lock:
            self._instance = {s.name: s for s in skills}

    def clear_instance_skills(self) -> None:
        with self._lock:
            self._instance.clear()

    # -- lookup -------------------------------------------------------------

    def get(self, name: str) -> SkillDefinition | None:
        """Look up a skill by name.  Instance > disk > bundled."""
        with self._lock:
            return (
                self._instance.get(name)
                or self._disk.get(name)
                or self._bundled.get(name)
            )

    def list_available(self) -> list[SkillDefinition]:
        """Return all model-invocable skills (deduplicated, priority order)."""
        with self._lock:
            seen: dict[str, SkillDefinition] = {}
            # Lower-priority first so higher-priority overwrites
            for source in (self._bundled, self._disk, self._instance):
                for name, skill in source.items():
                    if not skill.disable_model_invocation:
                        seen[name] = skill
            return sorted(seen.values(), key=lambda s: s.name)


# Module-level singleton
_registry = SkillRegistry()


def get_registry() -> SkillRegistry:
    """Return the module-level skill registry singleton."""
    return _registry


# ---------------------------------------------------------------------------
# Backward-compatible register_skill()
# ---------------------------------------------------------------------------


def register_skill(
    name: str,
    func: Callable[..., str],
    description: str = "",
) -> None:
    """Register a callable as a bundled skill (backward-compatible API).

    The callable is invoked once at registration time to capture its
    prompt text.  For dynamic callables that must run at invocation time,
    use ``get_registry().register_bundled()`` directly with a
    ``SkillDefinition`` whose ``prompt`` field contains the text.
    """
    try:
        prompt = func()
    except Exception:
        prompt = ""
    skill = SkillDefinition(
        name=name,
        description=description,
        prompt=str(prompt),
        source="bundled",
    )
    _registry.register_bundled(skill)


def get_registered_skills() -> dict[str, dict]:
    """Return a dict of all registered skills (backward-compatible API)."""
    return {
        s.name: {"description": s.description, "source": s.source}
        for s in _registry.list_available()
    }


# ---------------------------------------------------------------------------
# Tool function
# ---------------------------------------------------------------------------


def run_skill(skill: str, args: str | None = None) -> str:
    """Execute a registered skill or command by name with optional arguments.

    Performs inline expansion: substitutes ``${ARGUMENTS}`` in the skill's
    prompt and returns the expanded text as the tool result.
    """
    if not skill or not skill.strip():
        return "Error: No skill name provided."

    skill_name = skill.strip()
    skill_def = _registry.get(skill_name)

    if skill_def is None:
        available = [s.name for s in _registry.list_available()]
        if not available:
            available = ["(none registered)"]
        return (
            f"Error: Skill '{skill_name}' not found.\n"
            f"Available skills: {', '.join(available)}"
        )

    # ${ARGUMENTS} substitution (matches Claude Code's substituteArguments)
    prompt = skill_def.prompt.replace("${ARGUMENTS}", args or "")

    # Prepend allowed-tools directive for soft enforcement
    if skill_def.allowed_tools:
        tools_list = ", ".join(skill_def.allowed_tools)
        header = (
            f"<skill-context name=\"{skill_def.name}\">\n"
            f"IMPORTANT: While following these skill instructions, "
            f"you may ONLY use these tools: {tools_list}\n"
            f"</skill-context>\n\n"
        )
        prompt = header + prompt

    return prompt


from .prompt import get_skill_tool_description  # noqa: E402

run_skill.__doc__ = get_skill_tool_description()
