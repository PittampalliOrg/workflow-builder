"""Antigravity CLI (``agy``) TUI adapter (the ``agy-cli`` runtime).

``agy`` is Google's Antigravity CLI (a Go/Codeium-"jetski" rewrite that
supersedes Gemini CLI). Auth is **in-pod device-code OAuth**: on first launch
the bare TUI prints a Google authorization URL + waits for the user to paste the
authorization code (verified working in a keyring-less container — no browser,
no libsecret). So there is NO pre-provisioned credential (descriptor
``cliAuth.credentialKind = "device_login"``) and no spawn-time token gate; the
readiness gate's blocked-guard keeps the kickoff from being typed into the auth
prompt, and the kickoff injects only once the user has authenticated and the
TUI reaches its idle prompt.

Seeds:
  (a) MCP: agentConfig.mcpServers → ``$HOME/.gemini/config/mcp_config.json``
      (the confirmed HOME-level config agy actually loads). Remote servers use
      the ``serverUrl`` key (NOT ``url`` — renamed from Gemini CLI; miss it and
      the server fails silently).
  (b) system prompt: instructionBundle.rendered.system → ``$HOME/.gemini/GEMINI.md``.
  (c) settings: a minimal ``settings.json`` pre-trusts the sandbox workspace and
      pins the model (best-effort; agy replaces invalid settings with defaults).

agy has no OTEL export and no native herdr session integration (herdr
screen-detects its state). $HOME is pinned to the sandbox root so ``~/.gemini``
lands on the writable emptyDir; pane_env strips every Google/Gemini API-key env
so the OAuth path is taken.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Mapping

from src.cli_adapters.base import CliAdapter, SeedResult
from src.mcp_config import build_mcp_servers

logger = logging.getLogger(__name__)

DEFAULT_MODEL = os.environ.get("CLI_AGENT_AGY_DEFAULT_MODEL", "")
AGY_BIN = os.environ.get("CLI_AGENT_AGY_PATH", "agy")


def clean_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _agy_home() -> Path:
    """agy reads ``$HOME/.gemini``; we pin HOME to the sandbox root so its state
    lands on the writable emptyDir. seed() and pane_env MUST agree on this."""
    return Path(
        os.environ.get("CLI_AGENT_AGY_HOME")
        or os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")
    )


def normalize_agy_model(model_spec: Any) -> str | None:
    """Gemini/agy models only. A non-Gemini modelSpec is ignored so agy picks
    its own default (the model list is provider-internal)."""
    raw = clean_string(model_spec)
    if raw and raw.startswith("gemini/"):
        return raw.split("/", 1)[1]
    if raw and raw.lower().startswith("gemini"):
        return raw
    return clean_string(DEFAULT_MODEL)


def _agy_mcp_servers(agent_config: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """Claude Code .mcp.json shape (from build_mcp_servers) → agy mcp_config.json
    server map. Remote servers use ``serverUrl`` (agy's required key)."""
    servers = build_mcp_servers(agent_config)
    out: dict[str, dict[str, Any]] = {}
    for name, cfg in servers.items():
        if cfg.get("type") == "stdio":
            entry: dict[str, Any] = {"command": cfg.get("command")}
            if isinstance(cfg.get("args"), list):
                entry["args"] = [str(a) for a in cfg["args"]]
            if isinstance(cfg.get("env"), Mapping):
                entry["env"] = {str(k): str(v) for k, v in cfg["env"].items()}
            out[name] = entry
        else:
            url = clean_string(cfg.get("url"))
            if not url:
                continue
            entry = {"serverUrl": url}
            if isinstance(cfg.get("headers"), Mapping) and cfg["headers"]:
                entry["headers"] = {str(k): str(v) for k, v in cfg["headers"].items()}
            out[name] = entry
    return out


class AntigravityAdapter(CliAdapter):
    name = "antigravity"
    # Device-code OAuth happens in the pane on first launch — skip the kickoff
    # so the seed message is never typed into the authorization-code prompt.
    requires_interactive_login = True
    # agy mirrors events from herdr/native state (no UserPromptSubmit hook), so
    # the Claude-only INJECTION_MARKER has no dedup function here — don't send it.
    uses_injection_marker = False

    # -- seeding ----------------------------------------------------------------

    def seed(self, session_input: Mapping[str, Any]) -> SeedResult:
        agent_config = _record(session_input.get("agentConfig"))
        result = SeedResult()
        home = _agy_home()
        gemini_dir = home / ".gemini"
        config_dir = gemini_dir / "config"
        cli_dir = gemini_dir / "antigravity-cli"
        for d in (config_dir, cli_dir):
            d.mkdir(parents=True, exist_ok=True)

        # (a) MCP config (HOME-level — the one agy actually loads).
        servers = _agy_mcp_servers(agent_config)
        if servers:
            mcp_path = config_dir / "mcp_config.json"
            mcp_path.write_text(
                json.dumps({"mcpServers": servers}, indent=2) + "\n", encoding="utf-8"
            )
            result.paths["mcpConfigPath"] = str(mcp_path)

        # (b) system prompt → GEMINI.md.
        bundle = _record(session_input.get("instructionBundle"))
        rendered = _record(bundle.get("rendered"))
        system_text = clean_string(rendered.get("system"))
        if system_text:
            gemini_md = gemini_dir / "GEMINI.md"
            gemini_md.write_text(system_text + "\n", encoding="utf-8")
            result.paths["systemPromptPath"] = str(gemini_md)

        # (c) settings.json — pre-trust the sandbox workspace + pin the model so
        # the TUI doesn't surface a trust dialog. Best-effort (agy replaces an
        # invalid settings file with defaults); never clobber an existing one.
        settings_path = cli_dir / "settings.json"
        if not settings_path.exists():
            sandbox_root = os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")
            settings: dict[str, Any] = {"trustedWorkspaces": [sandbox_root]}
            model = normalize_agy_model(agent_config.get("modelSpec"))
            if model:
                settings["model"] = model
            settings_path.write_text(
                json.dumps(settings, indent=2) + "\n", encoding="utf-8"
            )
            result.paths["agySettingsPath"] = str(settings_path)

        return result

    # -- argv -----------------------------------------------------------------

    def build_argv(
        self, agent_config: Mapping[str, Any], seed_paths: Mapping[str, str]
    ) -> list[str]:
        argv: list[str] = [AGY_BIN]
        model = normalize_agy_model(agent_config.get("modelSpec"))
        if model:
            argv += ["--model", model]
        mode = clean_string(agent_config.get("permissionMode"))
        if mode in {"bypass", "bypassPermissions", "dontAsk", "auto"}:
            argv += ["--dangerously-skip-permissions"]
        return argv

    # -- env -------------------------------------------------------------------

    def pane_env(
        self,
        base_env: Mapping[str, str],
        *,
        session_id: str | None = None,
    ) -> dict[str, str]:
        env: dict[str, str] = {}
        passthrough = ("PATH", "TERM")
        for key in passthrough:
            value = base_env.get(key)
            if value:
                env[key] = value
        # Pin HOME to the sandbox root so ~/.gemini matches what seed() wrote.
        env["HOME"] = str(_agy_home())
        for key, value in base_env.items():
            if key.startswith("OTEL_") and value:
                env[key] = value
        if session_id:
            attrs = env.get("OTEL_RESOURCE_ATTRIBUTES", "")
            stamp = f"wfb.session.id={session_id}"
            env["OTEL_RESOURCE_ATTRIBUTES"] = f"{attrs},{stamp}" if attrs else stamp
        # Force the OAuth path: strip every API-key / service-account credential
        # so agy does not silently switch to an API key.
        for forbidden in (
            "ANTIGRAVITY_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "ANTHROPIC_API_KEY",
            "CLAUDE_API_KEY",
        ):
            env.pop(forbidden, None)
        return env
