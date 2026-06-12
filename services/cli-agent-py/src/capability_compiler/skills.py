"""Skill materialization for the capability compiler.

SSOT for the skill caps + path sanitizers (previously duplicated in
dapr-agent-py ``main.py`` and cli-agent-py ``claude_code.py``) and the two
NON-byte-unifiable skill emitters:

  * :func:`materialize_skills_local` — writes skill package files (BYTES) to a
    local-FS skills root. Used by the CLI runtimes (claude-code, codex, agy).
  * :func:`skill_package_entries` — returns STR-only entries (no base64, no
    resolved-path guard). Used by dapr-agent-py, which writes them through the
    OpenShell sandbox ``runtime.write_text`` API (NOT the local FS), and feeds
    them back into ``SkillDefinition.package_*`` for the Skill tool. The dapr
    path is deliberately distinct (see the Pillar-1 holes: it is more
    restrictive — str-only — and the write loop / SkillDefinition coupling stay
    in ``main.py``).

The caps are kept in lock-step with the BFF ingester
(``src/lib/server/skill-ingest.ts`` ``PACKAGE_MAX_*``); the BFF rejects
oversize bundles at ingestion and each runtime skips oversize files as
belt-and-braces.

Codex/agy gap-closure helpers (:func:`render_skills_index`,
:func:`compose_instruction_file`) are NEW — neither codex nor agy has native
skills auto-discovery, so the available skills are surfaced via a delimited,
idempotently-rewritten block in their instruction file (AGENTS.md / GEMINI.md).
Claude Code auto-discovers ``skills/<slug>/SKILL.md`` and needs no index.

Vendored byte-identical into each Python service by
``scripts/sync-runtime-registry.mjs``; the canonical source lives here.
"""

from __future__ import annotations

import base64
import binascii
import posixpath
import re
from pathlib import Path
from typing import Any, Mapping

# BFF skill-ingest caps (src/lib/server/skill-ingest.ts PACKAGE_MAX_*).
SKILL_MAX_FILE_BYTES = 128 * 1024
SKILL_MAX_TOTAL_BYTES = 2 * 1024 * 1024
SKILL_MAX_FILES = 80

# Delimited sentinel around the codex/agy "Available skills" index so the
# instruction file can be rewritten idempotently on every seed (a pod restart
# re-runs seed; appending would double-write).
SKILLS_BLOCK_START = "<!-- wfb:skills:start -->"
SKILLS_BLOCK_END = "<!-- wfb:skills:end -->"


def _clean(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def safe_skill_segment(value: str) -> str:
    """Port of the (identical) dapr/cli ``_safe_skill_segment``."""
    normalized = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip()).strip(".-")
    return normalized[:96] or "skill"


def safe_package_relative_path(value: Any) -> str | None:
    """Port of the (identical) dapr/cli ``_safe_package_relative_path``."""
    raw = str(value or "").replace("\\", "/").strip()
    if not raw:
        return None
    normalized = posixpath.normpath(raw).lstrip("/")
    if normalized in {"", "."} or normalized.startswith("../"):
        return None
    return normalized


def decode_file_content(raw_file: Mapping[str, Any]) -> bytes | None:
    """Port of cli-agent-py ``_decode_file_content`` (base64-TOLERANT).

    The plan describes base64 ``content``; the BFF ingester (skill-ingest.ts)
    actually stores plain UTF-8 ``content``. An explicit ``encoding: "base64"``
    or ``contentBase64`` field wins; otherwise the content is plain text. The
    dapr path (:func:`skill_package_entries`) is str-only and does NOT use this.
    """
    b64 = raw_file.get("contentBase64")
    if isinstance(b64, str) and b64.strip():
        try:
            return base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            return None
    content = raw_file.get("content")
    if not isinstance(content, str):
        return None
    if str(raw_file.get("encoding") or "").strip().lower() == "base64":
        try:
            return base64.b64decode(content, validate=True)
        except (binascii.Error, ValueError):
            return None
    return content.encode("utf-8")


def materialize_skills_local(
    agent_config: Mapping[str, Any],
    skills_root: Path,
    warnings: list[str],
) -> Path | None:
    """Write skill package files (BYTES) under ``skills_root/<slug>/``.

    Port of cli-agent-py ``ClaudeCodeAdapter._materialize_skills``, with the
    skills root parameterized so claude-code / codex / agy each pass their own
    (``$CLAUDE_CONFIG_DIR/skills`` / ``$CODEX_HOME/skills`` /
    ``_agy_home()/.gemini/skills``). Returns the root if anything materialized.
    """
    raw_skills = agent_config.get("skills")
    if not isinstance(raw_skills, list) or not raw_skills:
        return None
    skills_root.mkdir(parents=True, exist_ok=True)
    root_guard = skills_root.resolve()
    materialized_any = False
    for item in raw_skills:
        if not isinstance(item, Mapping):
            continue
        slug_source = _clean(item.get("slug")) or _clean(item.get("name"))
        manifest = item.get("packageManifest")
        raw_files = manifest.get("files") if isinstance(manifest, Mapping) else None
        prompt = _clean(item.get("prompt"))
        if not isinstance(raw_files, list) and not prompt:
            # id/slug-only entry — the BFF resolves manifests into agentConfig;
            # skip silently per the runtime contract.
            continue
        if not slug_source:
            continue
        skill_dir = skills_root / safe_skill_segment(slug_source)
        total_bytes = 0
        file_count = 0
        wrote_skill_md = False
        for raw_file in raw_files if isinstance(raw_files, list) else []:
            if not isinstance(raw_file, Mapping):
                continue
            rel_path = safe_package_relative_path(raw_file.get("path"))
            if not rel_path:
                warnings.append(f"skill {slug_source}: skipped unsafe path")
                continue
            data = decode_file_content(raw_file)
            if data is None:
                continue
            if len(data) > SKILL_MAX_FILE_BYTES:
                warnings.append(f"skill {slug_source}: skipped oversized file {rel_path}")
                continue
            if total_bytes + len(data) > SKILL_MAX_TOTAL_BYTES:
                warnings.append(f"skill {slug_source}: total byte cap reached")
                break
            if file_count >= SKILL_MAX_FILES:
                warnings.append(f"skill {slug_source}: file count cap reached")
                break
            target = (skill_dir / rel_path).resolve()
            # Belt-and-braces traversal guard on the resolved path.
            if root_guard not in target.parents and target != root_guard:
                warnings.append(f"skill {slug_source}: path escaped skills root: {rel_path}")
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            total_bytes += len(data)
            file_count += 1
            materialized_any = True
            if posixpath.basename(rel_path).upper() == "SKILL.MD":
                wrote_skill_md = True
        # Custom skills carry SKILL.md content as `prompt` (skill-ingest); write
        # it when the manifest didn't already include SKILL.md.
        if prompt and not wrote_skill_md and total_bytes + len(prompt.encode()) <= SKILL_MAX_TOTAL_BYTES:
            skill_dir.mkdir(parents=True, exist_ok=True)
            (skill_dir / "SKILL.md").write_text(prompt + "\n", encoding="utf-8")
            materialized_any = True
    return skills_root if materialized_any else None


def skill_package_entries(item: dict[str, Any]) -> list[dict[str, str]]:
    """Port of dapr-agent-py ``_extract_skill_package_entries`` (STR-only).

    Returns ``[{"path", "content"}]`` for one skill item — no base64 decode, no
    resolved-path guard (dapr writes these via ``runtime.write_text`` to the
    OpenShell sandbox, not the local FS). Deliberately more restrictive than
    :func:`materialize_skills_local`.
    """
    manifest = item.get("packageManifest")
    if not isinstance(manifest, dict):
        return []
    raw_files = manifest.get("files")
    if not isinstance(raw_files, list):
        return []
    entries: list[dict[str, str]] = []
    total_bytes = 0
    for raw_file in raw_files:
        if not isinstance(raw_file, dict):
            continue
        rel_path = safe_package_relative_path(raw_file.get("path"))
        content = raw_file.get("content")
        if not rel_path or not isinstance(content, str):
            continue
        encoded_size = len(content.encode("utf-8"))
        if encoded_size > SKILL_MAX_FILE_BYTES:
            continue
        if total_bytes + encoded_size > SKILL_MAX_TOTAL_BYTES:
            continue
        total_bytes += encoded_size
        entries.append({"path": rel_path, "content": content})
        if len(entries) >= SKILL_MAX_FILES:
            break
    return entries


def render_skills_index(
    agent_config: Mapping[str, Any],
    *,
    skills_subdir: str = "skills",
) -> str | None:
    """Build the codex/agy "Available skills" markdown index, or None.

    Lists every skill that actually materializes (has package files or a
    prompt) so a CLI without native skills auto-discovery (codex, agy) can find
    and read ``<skills_subdir>/<slug>/SKILL.md``.
    """
    raw_skills = agent_config.get("skills")
    if not isinstance(raw_skills, list):
        return None
    lines: list[str] = []
    for item in raw_skills:
        if not isinstance(item, Mapping):
            continue
        slug_source = _clean(item.get("slug")) or _clean(item.get("name"))
        if not slug_source:
            continue
        manifest = item.get("packageManifest")
        has_files = isinstance(manifest, Mapping) and isinstance(manifest.get("files"), list)
        if not has_files and not _clean(item.get("prompt")):
            continue
        slug = safe_skill_segment(slug_source)
        desc = (
            _clean(item.get("description"))
            or _clean(item.get("whenToUse"))
            or _clean(item.get("when_to_use"))
        )
        suffix = f" — {desc}" if desc else ""
        lines.append(f"- **{slug}**{suffix} (see `{skills_subdir}/{slug}/SKILL.md`)")
    if not lines:
        return None
    return "## Available skills\n\n" + "\n".join(lines)


def compose_instruction_file(
    system_text: Any,
    skills_index: str | None,
) -> str | None:
    """Compose a CLI instruction file (AGENTS.md / GEMINI.md) idempotently.

    Returns ``<system>\\n\\n<delimited skills block>\\n`` (either part optional),
    or None when both are empty. Rewriting the WHOLE file from
    ``rendered.system`` + a single delimited block each seed keeps a pod restart
    from double-appending and surfaces skills even when the system prompt is
    empty. With ``skills_index=None`` this reduces to ``<system>\\n`` —
    byte-identical to the prior system-prompt-only write.
    """
    parts: list[str] = []
    system = _clean(system_text)
    if system:
        parts.append(system)
    if skills_index:
        parts.append(f"{SKILLS_BLOCK_START}\n{skills_index.rstrip()}\n{SKILLS_BLOCK_END}")
    if not parts:
        return None
    return "\n\n".join(parts) + "\n"
