"""Plugin → SkillRegistry integration.

Loads SKILL.md files from enabled plugins and feeds them into the
existing ``SkillRegistry`` at the disk tier.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING

from .models import LoadedPlugin

if TYPE_CHECKING:
    from src.tools.skill_tool.models import SkillDefinition
    from src.tools.skill_tool.tool import SkillRegistry

logger = logging.getLogger(__name__)


def load_plugin_skills(plugins: list[LoadedPlugin]) -> list[SkillDefinition]:
    """Scan enabled plugins for skill definitions.

    Uses the existing ``parse_skill_md`` / ``load_skills_from_dir`` from
    ``src/tools/skill_tool/loader.py``.
    """
    from src.tools.skill_tool.loader import load_skills_from_dir

    all_skills: list[SkillDefinition] = []

    for plugin in plugins:
        if not plugin.enabled:
            continue

        # Collect all skill paths
        skill_paths: list[str] = []
        if plugin.skills_path:
            skill_paths.append(plugin.skills_path)
        skill_paths.extend(plugin.skills_paths)

        for spath in skill_paths:
            if not Path(spath).is_dir():
                continue
            skills = load_skills_from_dir(spath, source="plugin")
            if skills:
                logger.info(
                    "[plugins] Loaded %d skill(s) from plugin %s (%s)",
                    len(skills),
                    plugin.name,
                    spath,
                )
                all_skills.extend(skills)

    return all_skills


def register_plugin_skills(
    registry: SkillRegistry,
    plugins: list[LoadedPlugin] | tuple[LoadedPlugin, ...],
) -> None:
    """Feed plugin skills into the SkillRegistry at the disk tier.

    Merges plugin skills with any existing disk skills.
    """
    plugin_skills = load_plugin_skills(list(plugins))
    if not plugin_skills:
        return

    # Get existing disk skills and merge
    existing = registry.list_available()
    existing_names = {s.name for s in existing if s.source == "disk"}

    # Only add plugin skills that don't conflict with existing disk skills
    new_skills = [s for s in plugin_skills if s.name not in existing_names]
    if new_skills:
        # Append to disk tier
        all_disk = [
            s for s in existing if s.source == "disk"
        ] + new_skills
        registry.set_disk_skills(all_disk)
        logger.info("[plugins] Registered %d plugin skill(s)", len(new_skills))
