"""Byte-for-byte golden tests for the capability-compiler skill emitters.

``materialize_skills_local`` must reproduce cli-agent-py's pre-consolidation
``_materialize_skills`` file tree exactly, and ``skill_package_entries`` must
reproduce dapr-agent-py's ``_extract_skill_package_entries`` exactly. Both
oracles are FROZEN verbatim copies of the original logic (inlined, not
imported). The codex/agy index helpers are NEW (gap-closure) and tested for
shape + idempotency + the no-skills byte-identity to the prior write.

Run (no cluster):
    python -m pytest services/shared/capability_compiler/tests/test_skills_golden.py -q
"""

from __future__ import annotations

import base64
import binascii
import posixpath
import re
from pathlib import Path
from typing import Any, Mapping

import pytest

from capability_compiler.skills import (
    SKILL_MAX_FILE_BYTES,
    compose_instruction_file,
    materialize_skills_local,
    render_skills_index,
    skill_package_entries,
)

# --- frozen oracle: cli-agent-py _materialize_skills (verbatim, root-param) ----
_O_MAX_FILE = 128 * 1024
_O_MAX_TOTAL = 2 * 1024 * 1024
_O_MAX_FILES = 80


def _o_clean(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _o_segment(value: str) -> str:
    n = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip()).strip(".-")
    return n[:96] or "skill"


def _o_relpath(value: Any) -> str | None:
    raw = str(value or "").replace("\\", "/").strip()
    if not raw:
        return None
    n = posixpath.normpath(raw).lstrip("/")
    if n in {"", "."} or n.startswith("../"):
        return None
    return n


def _o_decode(raw_file: Mapping[str, Any]) -> bytes | None:
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


def _o_materialize(agent_config, skills_root: Path, warnings: list[str]) -> Path | None:
    raw_skills = agent_config.get("skills")
    if not isinstance(raw_skills, list) or not raw_skills:
        return None
    skills_root.mkdir(parents=True, exist_ok=True)
    root_guard = skills_root.resolve()
    materialized_any = False
    for item in raw_skills:
        if not isinstance(item, Mapping):
            continue
        slug_source = _o_clean(item.get("slug")) or _o_clean(item.get("name"))
        manifest = item.get("packageManifest")
        raw_files = manifest.get("files") if isinstance(manifest, Mapping) else None
        prompt = _o_clean(item.get("prompt"))
        if not isinstance(raw_files, list) and not prompt:
            continue
        if not slug_source:
            continue
        skill_dir = skills_root / _o_segment(slug_source)
        total_bytes = 0
        file_count = 0
        wrote_skill_md = False
        for raw_file in raw_files if isinstance(raw_files, list) else []:
            if not isinstance(raw_file, Mapping):
                continue
            rel_path = _o_relpath(raw_file.get("path"))
            if not rel_path:
                warnings.append(f"skill {slug_source}: skipped unsafe path")
                continue
            data = _o_decode(raw_file)
            if data is None:
                continue
            if len(data) > _O_MAX_FILE:
                warnings.append(f"skill {slug_source}: skipped oversized file {rel_path}")
                continue
            if total_bytes + len(data) > _O_MAX_TOTAL:
                warnings.append(f"skill {slug_source}: total byte cap reached")
                break
            if file_count >= _O_MAX_FILES:
                warnings.append(f"skill {slug_source}: file count cap reached")
                break
            target = (skill_dir / rel_path).resolve()
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
        if prompt and not wrote_skill_md and total_bytes + len(prompt.encode()) <= _O_MAX_TOTAL:
            skill_dir.mkdir(parents=True, exist_ok=True)
            (skill_dir / "SKILL.md").write_text(prompt + "\n", encoding="utf-8")
            materialized_any = True
    return skills_root if materialized_any else None


# --- frozen oracle: dapr _extract_skill_package_entries (verbatim) ------------
def _o_entries(item: dict[str, Any]) -> list[dict[str, str]]:
    manifest = item.get("packageManifest")
    if not isinstance(manifest, dict):
        return []
    raw_files = manifest.get("files")
    if not isinstance(raw_files, list):
        return []
    max_file_bytes = 128 * 1024
    max_total_bytes = 2 * 1024 * 1024
    max_files = 80
    entries: list[dict[str, str]] = []
    total_bytes = 0
    for raw_file in raw_files:
        if not isinstance(raw_file, dict):
            continue
        rel_path = _o_relpath(raw_file.get("path"))
        content = raw_file.get("content")
        if not rel_path or not isinstance(content, str):
            continue
        encoded_size = len(content.encode("utf-8"))
        if encoded_size > max_file_bytes:
            continue
        if total_bytes + encoded_size > max_total_bytes:
            continue
        total_bytes += encoded_size
        entries.append({"path": rel_path, "content": content})
        if len(entries) >= max_files:
            break
    return entries


def _tree(root: Path) -> list[tuple[str, bytes]]:
    if not root.exists():
        return []
    out = []
    for p in sorted(root.rglob("*")):
        if p.is_file():
            out.append((p.relative_to(root).as_posix(), p.read_bytes()))
    return out


# --- fixtures -----------------------------------------------------------------
def _ac(skills):
    return {"skills": skills}


_BIG = "x" * (SKILL_MAX_FILE_BYTES + 1)

SKILL_FIXTURES: dict[str, dict] = {
    "manifest_files": _ac([{"slug": "pdf", "packageManifest": {"files": [
        {"path": "SKILL.md", "content": "# PDF\n"},
        {"path": "refs/notes.md", "content": "notes"},
    ]}}]),
    "prompt_only": _ac([{"slug": "writer", "prompt": "You write well."}]),
    "prompt_and_files_no_skillmd": _ac([{"slug": "mix", "prompt": "fallback", "packageManifest": {"files": [
        {"path": "helper.py", "content": "print(1)"},
    ]}}]),
    "files_with_skillmd_suppresses_prompt": _ac([{"slug": "both", "prompt": "ignored", "packageManifest": {"files": [
        {"path": "skill.md", "content": "lower case name\n"},
    ]}}]),
    "base64_content": _ac([{"slug": "b64", "packageManifest": {"files": [
        {"path": "data.bin", "content": base64.b64encode(b"\x00\x01\x02").decode(), "encoding": "base64"},
    ]}}]),
    "content_base64_field": _ac([{"slug": "b64f", "packageManifest": {"files": [
        {"path": "data.bin", "contentBase64": base64.b64encode(b"\xff\xfe").decode()},
    ]}}]),
    "traversal_attempt": _ac([{"slug": "evil", "packageManifest": {"files": [
        {"path": "../../etc/passwd", "content": "x"},
        {"path": "ok.md", "content": "ok"},
    ]}}]),
    "oversized_file": _ac([{"slug": "big", "packageManifest": {"files": [
        {"path": "huge.txt", "content": _BIG},
        {"path": "small.txt", "content": "ok"},
    ]}}]),
    "dup_slug": _ac([
        {"slug": "Dup Skill", "prompt": "first"},
        {"slug": "dup-skill", "prompt": "second"},
    ]),
    "id_only_skipped": _ac([{"slug": "ref-only"}]),
    "no_skills": {},
    "empty_skills": _ac([]),
}


@pytest.mark.parametrize("name", list(SKILL_FIXTURES))
def test_materialize_local_matches_oracle(name, tmp_path):
    ac = SKILL_FIXTURES[name]
    new_root, new_warn = tmp_path / "new", []
    old_root, old_warn = tmp_path / "old", []
    new_ret = materialize_skills_local(ac, new_root, new_warn)
    old_ret = _o_materialize(ac, old_root, old_warn)
    assert _tree(new_root) == _tree(old_root), name
    assert new_warn == old_warn, name
    assert (new_ret is None) == (old_ret is None), name


@pytest.mark.parametrize("name", list(SKILL_FIXTURES))
def test_skill_entries_matches_oracle(name):
    ac = SKILL_FIXTURES[name]
    for item in ac.get("skills", []):
        if isinstance(item, dict):
            assert skill_package_entries(item) == _o_entries(item), name


def test_traversal_blocked_but_safe_file_kept(tmp_path):
    ac = SKILL_FIXTURES["traversal_attempt"]
    warn: list[str] = []
    materialize_skills_local(ac, tmp_path, warn)
    tree = {p for p, _ in _tree(tmp_path)}
    assert "evil/ok.md" in tree
    assert not any("passwd" in p for p in tree)
    assert any("unsafe path" in w for w in warn)


# --- NEW codex/agy gap-closure helpers ----------------------------------------
def test_render_index_lists_materializing_skills():
    idx = render_skills_index(_ac([
        {"slug": "pdf", "description": "Work with PDFs", "prompt": "x"},
        {"slug": "ref-only"},  # no files/prompt -> excluded
        {"name": "Web Search", "packageManifest": {"files": [{"path": "SKILL.md", "content": "x"}]}},
    ]))
    assert "## Available skills" in idx
    assert "- **pdf** — Work with PDFs (see `skills/pdf/SKILL.md`)" in idx
    assert "- **Web-Search** (see `skills/Web-Search/SKILL.md`)" in idx
    assert "ref-only" not in idx


def test_render_index_none_without_skills():
    assert render_skills_index({}) is None
    assert render_skills_index(_ac([{"slug": "ref-only"}])) is None


def test_compose_system_only_is_byte_identical_to_prior_write():
    # Prior codex/agy behavior: write(system_text + "\n"). compose with no skills
    # must reproduce it exactly so the no-skills path stays golden.
    assert compose_instruction_file("You are helpful.", None) == "You are helpful.\n"
    assert compose_instruction_file("  spaced  ", None) == "spaced\n"
    assert compose_instruction_file(None, None) is None
    assert compose_instruction_file("", None) is None


def test_compose_skills_only_and_both_and_idempotent():
    idx = render_skills_index(_ac([{"slug": "pdf", "prompt": "x"}]))
    skills_only = compose_instruction_file(None, idx)
    assert skills_only is not None and skills_only.endswith("\n")
    assert "<!-- wfb:skills:start -->" in skills_only and "<!-- wfb:skills:end -->" in skills_only
    both = compose_instruction_file("SYS", idx)
    assert both.startswith("SYS\n\n<!-- wfb:skills:start -->")
    # Idempotent: composing again from the same inputs yields the same bytes
    # (the instruction file is rewritten, never appended).
    assert compose_instruction_file("SYS", idx) == both
