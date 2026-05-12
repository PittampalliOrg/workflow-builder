"""SKILL.md loader -- parse frontmatter and scan skill directories.

Ported from claude-code-src/main/skills/loadSkillsDir.ts.

Skills live in subdirectories containing a ``SKILL.md`` file::

    skills/
      my-skill/
        SKILL.md          # frontmatter + prompt body

The frontmatter uses ``---`` fences (same format as Claude Code)::

    ---
    name: my-skill
    description: Does something useful
    when_to_use: When the user asks to do X
    allowed-tools: Read, Grep, Glob
    arguments: target, scope
    argument-hint: <target> [scope]
    model: sonnet
    user-invocable: true
    disable-model-invocation: false
    ---

    # Prompt body here ...
    ${ARGUMENTS}
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path

from .models import SkillDefinition

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Frontmatter parser (regex-based, no PyYAML dependency)
# ---------------------------------------------------------------------------

_FRONTMATTER_RE = re.compile(
    r"\A\s*---[ \t]*\n(.*?)\n---[ \t]*\n(.*)",
    re.DOTALL,
)

# Matches a YAML-style key: value line (simple scalars only).
_KV_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$")


def parse_frontmatter(content: str) -> tuple[dict[str, str], str]:
    """Split a SKILL.md file into (frontmatter_dict, body).

    Returns an empty dict and the full content as body when no valid
    frontmatter fences are found.
    """
    m = _FRONTMATTER_RE.match(content)
    if not m:
        return {}, content

    raw_header, body = m.group(1), m.group(2)
    meta: dict[str, str] = {}
    for line in raw_header.splitlines():
        kv = _KV_RE.match(line)
        if kv:
            meta[kv.group(1).strip()] = kv.group(2).strip()
    return meta, body


def _parse_bool(value: str, default: bool = True) -> bool:
    """Parse a boolean frontmatter value."""
    lower = value.strip().lower()
    if lower in ("true", "yes", "1"):
        return True
    if lower in ("false", "no", "0"):
        return False
    return default


def _parse_csv(value: str) -> tuple[str, ...]:
    """Parse a comma-separated frontmatter value into a tuple of strings."""
    items = [item.strip() for item in value.split(",") if item.strip()]
    return tuple(items)


# ---------------------------------------------------------------------------
# SKILL.md → SkillDefinition
# ---------------------------------------------------------------------------


def parse_skill_md(
    content: str,
    name: str,
    source: str = "disk",
) -> SkillDefinition:
    """Parse a SKILL.md file into a :class:`SkillDefinition`.

    Parameters
    ----------
    content:
        The full text of the SKILL.md file.
    name:
        Fallback name (typically the containing directory name).
    source:
        Origin tag (``"disk"``, ``"bundled"``, ``"agentConfig"``).
    """
    meta, body = parse_frontmatter(content)

    return SkillDefinition(
        name=meta.get("name", name),
        description=meta.get("description", ""),
        prompt=body.strip(),
        source=source,
        when_to_use=meta.get("when_to_use", meta.get("when-to-use", "")),
        allowed_tools=_parse_csv(meta["allowed-tools"]) if "allowed-tools" in meta else (),
        arguments=_parse_csv(meta["arguments"]) if "arguments" in meta else (),
        argument_hint=meta.get("argument-hint", ""),
        model_override=meta.get("model", ""),
        user_invocable=_parse_bool(meta["user-invocable"]) if "user-invocable" in meta else True,
        disable_model_invocation=(
            _parse_bool(meta["disable-model-invocation"], default=False)
            if "disable-model-invocation" in meta
            else False
        ),
    )


# ---------------------------------------------------------------------------
# Directory scanner
# ---------------------------------------------------------------------------


def load_skills_from_dir(
    dir_path: str,
    source: str = "disk",
) -> list[SkillDefinition]:
    """Load skills from a directory of ``skill-name/SKILL.md`` subdirs.

    Mirrors the structure expected by Claude Code's ``loadSkillsFromSkillsDir``.
    """
    skills: list[SkillDefinition] = []
    base = Path(dir_path)
    if not base.is_dir():
        return skills

    for entry in sorted(base.iterdir()):
        if not entry.is_dir():
            continue
        skill_file = entry / "SKILL.md"
        if not skill_file.is_file():
            continue
        try:
            content = skill_file.read_text(encoding="utf-8")
            skill = parse_skill_md(content, name=entry.name, source=source)
            skills.append(skill)
            logger.info("[skills] Loaded skill '%s' from %s", skill.name, skill_file)
        except Exception as exc:
            logger.warning("[skills] Failed to load %s: %s", skill_file, exc)

    return skills
