"""Claude Code TUI adapter (the `claude-code-cli` runtime's only adapter v1).

Seeds per-session artifacts and builds the pane argv/env for the real
``claude`` TUI running in a herdr pane:

  (a) MCP: vendored translation (src/mcp_config.py, FROM claude-agent-py)
      emitted in Claude Code ``.mcp.json`` shape → /sandbox/.wfb/mcp.json;
      argv gains ``--mcp-config`` when any servers are declared.
  (b) skills: agentConfig.skills packageManifest.files materialized to
      ``$CLAUDE_CONFIG_DIR/skills/<slug>/`` with the BFF ingester caps
      (128KB/file, 2MB total, 80 files) + path-traversal safety — mirrors
      dapr-agent-py's ``_materialize_instance_skill_packages``. Skill entries
      without manifests are skipped silently (the BFF resolves manifests into
      agentConfig).
  (c) system prompt: instructionBundle.rendered.system →
      /sandbox/.wfb/system-prompt.md; argv ``--append-system-prompt-file``
      only when non-empty.
  (d) permissionMode: normalize_permission_mode ported from
      claude-agent-py/src/claude_sdk_runner.py, constrained to the CLI's
      documented modes.
  (e) model: normalize_claude_model copied from claude_sdk_runner.py.
  (g) pane_env: CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_CONFIG_DIR / OTEL_* /
      CLAUDE_CODE_ENABLE_TELEMETRY pass-through + wfb.session.id resource
      attribute; NEVER ANTHROPIC_API_KEY / CLAUDE_API_KEY.

Static hook wiring lives in the image's /etc/claude-code/managed-settings.json
(see Dockerfile.sandbox) — nothing per-session is needed there v1, so no
per-session settings.json is written (per-session knobs all travel via argv).
"""

from __future__ import annotations

import base64
import binascii
import logging
import os
import posixpath
import re
from pathlib import Path
from typing import Any, Mapping

from src.cli_adapters.base import CliAdapter, SeedResult, link_transcript_subtree
from src.mcp_config import build_mcp_servers

logger = logging.getLogger(__name__)

DEFAULT_MODEL = os.environ.get("CLI_AGENT_PY_DEFAULT_MODEL", "claude-opus-4-8")
# Interactive TUI default: "default" (permission prompts surface to the live
# user via the web terminal + blocked-state events) — unlike claude-agent-py's
# headless bypassPermissions default.
DEFAULT_PERMISSION_MODE = os.environ.get("CLI_AGENT_PY_PERMISSION_MODE", "default")
CLI_BIN = os.environ.get("CLI_AGENT_CLI_PATH", "claude")

# Modes the Claude Code CLI's --permission-mode flag accepts.
_CLI_PERMISSION_MODES = {"default", "acceptEdits", "plan", "bypassPermissions"}

# BFF skill-ingest caps (src/lib/server/skill-ingest.ts PACKAGE_MAX_*), kept in
# lock-step with dapr-agent-py's _extract_skill_package_entries.
SKILL_MAX_FILE_BYTES = 128 * 1024
SKILL_MAX_TOTAL_BYTES = 2 * 1024 * 1024
SKILL_MAX_FILES = 80


def clean_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def normalize_claude_model(model_spec: Any) -> str | None:
    """Copied from claude-agent-py/src/claude_sdk_runner.py."""
    raw = clean_string(model_spec)
    if not raw:
        raw = clean_string(DEFAULT_MODEL)
    if not raw:
        return None
    if raw.startswith("anthropic/"):
        return raw.split("/", 1)[1]
    if raw.startswith("claude-"):
        return raw
    fallback = clean_string(DEFAULT_MODEL)
    if fallback and fallback.startswith("anthropic/"):
        return fallback.split("/", 1)[1]
    return fallback


def normalize_permission_mode(value: Any) -> str:
    """Ported from claude-agent-py/src/claude_sdk_runner.py, constrained to the
    CLI's documented --permission-mode set (SDK-only modes map to bypass)."""
    raw = clean_string(value) or DEFAULT_PERMISSION_MODE
    if raw == "bypass":
        return "bypassPermissions"
    if raw in _CLI_PERMISSION_MODES:
        return raw
    if raw in {"dontAsk", "auto"}:
        return "bypassPermissions"
    return DEFAULT_PERMISSION_MODE if DEFAULT_PERMISSION_MODE in _CLI_PERMISSION_MODES else "default"


def _wfb_dir() -> Path:
    return Path(os.environ.get("CLI_AGENT_WFB_DIR", "/sandbox/.wfb"))


def _claude_config_dir() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR", "/sandbox/.claude"))


def _safe_skill_segment(value: str) -> str:
    """Mirror of dapr-agent-py _safe_skill_segment (main.py)."""
    normalized = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip()).strip(".-")
    return normalized[:96] or "skill"


def _safe_package_relative_path(value: Any) -> str | None:
    """Mirror of dapr-agent-py _safe_package_relative_path (main.py)."""
    raw = str(value or "").replace("\\", "/").strip()
    if not raw:
        return None
    normalized = posixpath.normpath(raw).lstrip("/")
    if normalized in {"", "."} or normalized.startswith("../"):
        return None
    return normalized


def _decode_file_content(raw_file: Mapping[str, Any]) -> bytes | None:
    """Tolerate both encodings: the plan describes base64 ``content``; the BFF
    ingester (skill-ingest.ts) actually stores plain UTF-8 ``content``. An
    explicit ``encoding: "base64"`` or ``contentBase64`` field wins; otherwise
    the content is treated as plain text."""
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


class ClaudeCodeAdapter(CliAdapter):
    name = "claude-code"
    # Content-gate the kickoff on the rendered REPL composer. Even though claude
    # mirrors state from its hooks, herdr can briefly report `idle` during the
    # boot/onboarding screen before the composer exists, stranding an
    # agent_status-gated seed (the same intermittent premature-idle race that
    # affects codex/agy). Claude Code's idle composer always renders the
    # `? for shortcuts` hint footer (absent on the boot screen), so gate on it.
    # On gate timeout the lifecycle still injects best-effort (never worse).
    prompt_ready_marker = "? for shortcuts"

    # -- seeding ----------------------------------------------------------------

    def seed(self, session_input: Mapping[str, Any]) -> SeedResult:
        agent_config = _record(session_input.get("agentConfig"))
        result = SeedResult()
        wfb_dir = _wfb_dir()
        wfb_dir.mkdir(parents=True, exist_ok=True)

        # (a) MCP config in Claude Code .mcp.json shape.
        servers = build_mcp_servers(agent_config)
        if servers:
            import json

            mcp_path = wfb_dir / "mcp.json"
            mcp_path.write_text(
                json.dumps({"mcpServers": servers}, indent=2) + "\n", encoding="utf-8"
            )
            result.paths["mcpConfigPath"] = str(mcp_path)

        # (c) system prompt.
        bundle = _record(session_input.get("instructionBundle"))
        rendered = _record(bundle.get("rendered"))
        system_text = clean_string(rendered.get("system"))
        if system_text:
            prompt_path = wfb_dir / "system-prompt.md"
            prompt_path.write_text(system_text + "\n", encoding="utf-8")
            result.paths["systemPromptPath"] = str(prompt_path)

        # (b) skills.
        skills_dir = self._materialize_skills(agent_config, result.warnings)
        if skills_dir:
            result.paths["skillsDir"] = str(skills_dir)

        # (h) First-run onboarding state. Without this, claude in a fresh pod
        # opens the theme picker + login-method screen; choosing the
        # subscription login launches a browser OAuth flow that cannot work in
        # a pod — the pane exits and the lifecycle terminates the session
        # (observed live on the first ryzen E2E run, 2026-06-10). Auth comes
        # from the CLAUDE_CODE_OAUTH_TOKEN pane env (verified working via
        # `claude -p` in the same pod); pre-completing onboarding + trust for
        # the sandbox cwd boots the TUI straight into the REPL.
        self._seed_onboarding_state(result)

        # (i) Durable transcript store. When the sandbox mounts a per-session
        # JuiceFS subtree (CLI_TRANSCRIPT_MOUNT), redirect claude's transcript
        # dir ($CLAUDE_CONFIG_DIR/projects) into it so the conversation persists
        # to Postgres and native `--resume` works across pods. No-op otherwise.
        linked = link_transcript_subtree(_claude_config_dir() / "projects", "claude")
        if linked:
            result.paths["transcriptStore"] = linked

        return result

    def _seed_onboarding_state(self, result: SeedResult) -> None:
        config_dir = _claude_config_dir()
        config_dir.mkdir(parents=True, exist_ok=True)
        # With CLAUDE_CONFIG_DIR set, claude keeps its state json inside the
        # config dir. The dot-name is the canonical one (~/.claude.json moved
        # into the dir); the bare name is written too in case a future CLI
        # drops the dot — an extra unread file is harmless.
        state_paths = [config_dir / ".claude.json", config_dir / "claude.json"]
        if any(p.exists() for p in state_paths):
            return  # pod restart / resumed state — never clobber claude's own file
        cwd = os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")
        state = {
            "hasCompletedOnboarding": True,
            "theme": "dark",
            # Only consulted when permissionMode=bypassPermissions is
            # configured; pre-accepting avoids a second blocking dialog there.
            "bypassPermissionsModeAccepted": True,
            "projects": {
                cwd: {
                    "hasTrustDialogAccepted": True,
                    "hasCompletedProjectOnboarding": True,
                }
            },
        }
        import json

        payload = json.dumps(state, indent=2) + "\n"
        for path in state_paths:
            path.write_text(payload, encoding="utf-8")
        result.paths["claudeStatePath"] = str(state_paths[0])

    def _materialize_skills(
        self, agent_config: Mapping[str, Any], warnings: list[str]
    ) -> Path | None:
        raw_skills = agent_config.get("skills")
        if not isinstance(raw_skills, list) or not raw_skills:
            return None
        skills_root = _claude_config_dir() / "skills"
        skills_root.mkdir(parents=True, exist_ok=True)
        root_guard = skills_root.resolve()
        materialized_any = False
        for item in raw_skills:
            if not isinstance(item, Mapping):
                continue
            slug_source = clean_string(item.get("slug")) or clean_string(item.get("name"))
            manifest = item.get("packageManifest")
            raw_files = manifest.get("files") if isinstance(manifest, Mapping) else None
            prompt = clean_string(item.get("prompt"))
            if not isinstance(raw_files, list) and not prompt:
                # id/slug-only entry — the BFF resolves manifests into
                # agentConfig; skip silently per the runtime contract.
                continue
            if not slug_source:
                continue
            skill_dir = skills_root / _safe_skill_segment(slug_source)
            total_bytes = 0
            file_count = 0
            wrote_skill_md = False
            for raw_file in raw_files if isinstance(raw_files, list) else []:
                if not isinstance(raw_file, Mapping):
                    continue
                rel_path = _safe_package_relative_path(raw_file.get("path"))
                if not rel_path:
                    warnings.append(f"skill {slug_source}: skipped unsafe path")
                    continue
                data = _decode_file_content(raw_file)
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
            # Custom skills carry SKILL.md content as `prompt` (skill-ingest);
            # write it when the manifest didn't already include SKILL.md.
            if prompt and not wrote_skill_md and total_bytes + len(prompt.encode()) <= SKILL_MAX_TOTAL_BYTES:
                skill_dir.mkdir(parents=True, exist_ok=True)
                (skill_dir / "SKILL.md").write_text(prompt + "\n", encoding="utf-8")
                materialized_any = True
        return skills_root if materialized_any else None

    # -- argv -----------------------------------------------------------------

    def build_argv(
        self, agent_config: Mapping[str, Any], seed_paths: Mapping[str, str]
    ) -> list[str]:
        argv: list[str] = [CLI_BIN]
        # Resume: the durable transcript subtree of the original conversation is
        # re-mounted at $CLAUDE_CONFIG_DIR/projects (same path), so `--continue`
        # picks up the most-recent conversation there (no session id needed). The
        # BFF sets continueSession only when the session re-mounts that subtree.
        if bool(agent_config.get("continueSession")):
            argv += ["--continue"]
        model = normalize_claude_model(agent_config.get("modelSpec"))
        if model:
            argv += ["--model", model]
        argv += [
            "--permission-mode",
            normalize_permission_mode(agent_config.get("permissionMode")),
        ]
        mcp_path = clean_string(seed_paths.get("mcpConfigPath"))
        if mcp_path:
            argv += ["--mcp-config", mcp_path]
        prompt_path = clean_string(seed_paths.get("systemPromptPath"))
        if prompt_path:
            # TODO(claude-cli-smoke): verify --append-system-prompt-file exists on
            # the pinned CLI version; fall back to --append-system-prompt "$(cat)"
            # if only the inline flag is available.
            argv += ["--append-system-prompt-file", prompt_path]
        return argv

    # -- env -------------------------------------------------------------------

    def pane_env(
        self,
        base_env: Mapping[str, str],
        *,
        session_id: str | None = None,
    ) -> dict[str, str]:
        env: dict[str, str] = {}
        passthrough = (
            "CLAUDE_CODE_OAUTH_TOKEN",  # subscription auth — explicitly ALLOWED
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_ENABLE_TELEMETRY",
            "DISABLE_AUTOUPDATER",
            "HOME",
            "PATH",
            "TERM",
        )
        for key in passthrough:
            value = base_env.get(key)
            if value:
                env[key] = value
        for key, value in base_env.items():
            if key.startswith("OTEL_") and value:
                env[key] = value
        if session_id:
            attrs = env.get("OTEL_RESOURCE_ATTRIBUTES", "")
            stamp = f"wfb.session.id={session_id}"
            env["OTEL_RESOURCE_ATTRIBUTES"] = f"{attrs},{stamp}" if attrs else stamp
        # NEVER forward API-key auth — it silently outranks the OAuth token and
        # flips billing from subscription to API (startup guard in main.py is
        # the first line of defense; this is the second).
        env.pop("ANTHROPIC_API_KEY", None)
        env.pop("CLAUDE_API_KEY", None)
        return env
