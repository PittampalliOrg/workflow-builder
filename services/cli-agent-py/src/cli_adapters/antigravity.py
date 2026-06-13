"""Antigravity CLI (``agy``) TUI adapter (the ``agy-cli`` runtime).

``agy`` is Google's Antigravity CLI (a Go/Codeium-"jetski" rewrite that
supersedes Gemini CLI). Auth is **in-pod device-code OAuth**: on first launch
the bare TUI prints a Google authorization URL + waits for the user to paste the
authorization code. This is VERIFIED working end-to-end in our keyring-less
sandbox (full URL → Google consent → code → token exchange → onboarding → idle
prompt, model responds).

Why not pre-provision the credential like codex? The interactive TUI reads its
OAuth token **only from the OS keyring** (``codeassistclient.KeyringTokenStorage``
over the freedesktop Secret Service) — it ignores ``~/.gemini`` token FILES (those
back only the headless ``agy -p`` path) and, with no keyring in the pod, doesn't
persist the obtained token to a file either. So there is nothing to inject: the
descriptor declares ``cliAuth.credentialKind = "device_login"`` (nothing stored)
and there is no spawn-time token gate. ``requires_interactive_login = True`` makes
the lifecycle DEFER the kickoff to the user post-auth — herdr screen-detects the
auth-code prompt as ``idle``, so an armed seed would otherwise be typed straight
into the login field. The web terminal surfaces the (otherwise hard-wrapped)
OAuth URL with Copy/Open; the user logs in, completes onboarding, then types.

Seeds (these DO apply — they configure the CLI, not its auth):
  (a) MCP: agentConfig.mcpServers → ``$HOME/.gemini/config/mcp_config.json``
      (the confirmed HOME-level config agy actually loads). Remote servers use
      the ``serverUrl`` key (NOT ``url`` — renamed from Gemini CLI; miss it and
      the server fails silently).
  (b) system prompt: instructionBundle.rendered.system → ``$HOME/.gemini/GEMINI.md``.
  (c) settings: a minimal ``settings.json`` pre-trusts the sandbox workspace,
      pins the model, and disables telemetry (best-effort; agy replaces invalid
      settings with defaults).

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

from src.agy_capture import restore_bundle, start_capture_watcher
from src.cli_adapters.base import (
    CliAdapter,
    SeedResult,
    hook_relay_command,
    write_hook_relay_script,
)
from src.capability_compiler import (
    compose_instruction_file,
    emit_claude_code_cli_servers,
    materialize_skills_local,
    render_skills_index,
)

logger = logging.getLogger(__name__)

DEFAULT_MODEL = os.environ.get("CLI_AGENT_AGY_DEFAULT_MODEL", "")
AGY_BIN = os.environ.get("CLI_AGENT_AGY_PATH", "agy")
# The stored ~/.gemini login bundle (base64 tar.gz), delivered when the user has
# a captured agy login. Present → agy boots signed in (no device-code login).
AGY_AUTH_ENV = "AGY_AUTH_JSON"


def clean_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _agy_home() -> Path:
    """Where agy actually reads/writes ``$HOME/.gemini``.

    agy is launched by herdr with the pod USER's passwd ``HOME`` — the pane_env
    HOME override does NOT stick for agy (unlike claude/codex, which use their
    own ``*_CONFIG_DIR`` env vars independent of HOME). Empirically agy writes
    ``/home/<user>/.gemini`` even when pane_env sets HOME=/sandbox. So target the
    runtime user's real home; seed(), the capture watcher, and restore MUST all
    agree on this. (The legacy ``CLI_AGENT_AGY_HOME=/sandbox`` deployment env is
    deliberately NOT honored — it pointed at the wrong dir.) ``CLI_AGENT_AGY_HOME_OVERRIDE``
    forces a value for tests."""
    override = os.environ.get("CLI_AGENT_AGY_HOME_OVERRIDE")
    if override:
        return Path(override)
    try:
        import pwd

        return Path(pwd.getpwuid(os.getuid()).pw_dir)  # passwd HOME — what herdr gives agy
    except Exception:  # noqa: BLE001
        return Path(os.environ.get("HOME") or os.path.expanduser("~"))


def _hook_relay_path() -> Path:
    root = os.environ.get("CLI_AGENT_WFB_DIR")
    if root:
        return Path(root) / "wfb_hook_relay.py"
    return (
        Path(os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox"))
        / ".wfb"
        / "wfb_hook_relay.py"
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
    servers = emit_claude_code_cli_servers(agent_config)
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


def _agy_hook_group(event: str, *, matcher: str | None = None) -> list[dict[str, Any]]:
    relay = _hook_relay_path()
    group: dict[str, Any] = {
        "hooks": [
            {
                "type": "command",
                "command": hook_relay_command(
                    relay, adapter="antigravity", event=event
                ),
            }
        ]
    }
    if matcher is not None:
        group["matcher"] = matcher
    return [group]


def _render_hooks_json() -> str:
    # Antigravity docs describe hooks.json as a map of hook names to event
    # configurations, located in the customization directory. agy currently
    # triggers from ~/.gemini/config/hooks.json, the same directory as MCP.
    payload = {
        "workflow-builder": {
            "enabled": True,
            "SessionStart": _agy_hook_group("SessionStart"),
            "PreToolUse": _agy_hook_group("PreToolUse", matcher="*"),
            "PostToolUse": _agy_hook_group("PostToolUse", matcher="*"),
            "Stop": _agy_hook_group("Stop"),
        }
    }
    return json.dumps(payload, indent=2) + "\n"


def _text_from_payload(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            text = _text_from_payload(item)
            if text:
                parts.append(text)
        if parts:
            return "\n\n".join(parts)
    if isinstance(value, Mapping):
        for key in (
            "finalResponse",
            "response",
            "message",
            "content",
            "text",
            "output",
            "result",
        ):
            text = _text_from_payload(value.get(key))
            if text:
                return text
    return None


class AntigravityAdapter(CliAdapter):
    name = "antigravity"
    # agy mirrors events from herdr/native state (no UserPromptSubmit hook), so
    # the Claude-only INJECTION_MARKER has no dedup function here — don't send it.
    uses_injection_marker = False
    # herdr only SCREEN-DETECTS agy (no native state) and reports `idle` during the
    # pre-composer boot screen, so the kickoff must wait until agy's composer is
    # actually rendered — gate on its idle-prompt footer.
    prompt_ready_marker = "? for shortcuts"

    @property
    def requires_interactive_login(self) -> bool:
        # agy is FILE-based (the OS-keyring path is vestigial). When a captured
        # ~/.gemini bundle is delivered (AGY_AUTH_JSON), seed() restores it and
        # agy boots already signed in → the kickoff can fire immediately. With NO
        # bundle, the user completes in-pane device-code OAuth first, so the
        # lifecycle must DEFER the kickoff (herdr reports the auth-code prompt as
        # `idle`, and an armed seed would land in the login field).
        return not bool(os.environ.get(AGY_AUTH_ENV))

    def on_session_started(self, session_id: str | None) -> None:
        # Auto-capture: watch ~/.gemini and POST the curated login bundle to the
        # BFF whenever agy writes/refreshes its token, so a one-time login seeds
        # every future pod. Runs whether or not a bundle was injected (captures
        # refreshed tokens too).
        if session_id:
            start_capture_watcher(session_id, _agy_home() / ".gemini")

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

        # (0) Restore the captured ~/.gemini login bundle (if delivered) so agy
        # boots already signed in. Never clobbers an existing file; the managed
        # files below (MCP / GEMINI.md) are then (re)written so ours win.
        blob = os.environ.get(AGY_AUTH_ENV)
        if blob and blob.strip():
            try:
                written = restore_bundle(gemini_dir, blob.strip())
                result.paths["agyAuthRestored"] = str(written)
            except Exception as exc:  # noqa: BLE001
                result.warnings.append(f"agy: failed to restore login bundle: {exc}")

        # (a) MCP config (HOME-level — the one agy actually loads).
        servers = _agy_mcp_servers(agent_config)
        if servers:
            mcp_path = config_dir / "mcp_config.json"
            mcp_path.write_text(
                json.dumps({"mcpServers": servers}, indent=2) + "\n", encoding="utf-8"
            )
            result.paths["mcpConfigPath"] = str(mcp_path)

        # (a2) Hook relay config. The CLI currently triggers hooks from
        # ~/.gemini/config/hooks.json, not antigravity-cli/settings.json.
        relay = write_hook_relay_script(_hook_relay_path())
        hooks_path = config_dir / "hooks.json"
        hooks_path.write_text(_render_hooks_json(), encoding="utf-8")
        result.paths["hookRelayPath"] = str(relay)
        result.paths["hooksPath"] = str(hooks_path)

        # (b) skills → _agy_home()/.gemini/skills/<slug>/ ; system prompt + a
        # skills index → GEMINI.md. agy has no native skills auto-discovery, so
        # the index (a delimited block, REWRITTEN each seed for restart
        # idempotency) surfaces the skills + where their SKILL.md lives. With no
        # skills this reduces to the prior system-prompt-only write.
        materialize_skills_local(agent_config, gemini_dir / "skills", result.warnings)
        bundle = _record(session_input.get("instructionBundle"))
        rendered = _record(bundle.get("rendered"))
        instructions = compose_instruction_file(
            rendered.get("system"), render_skills_index(agent_config)
        )
        if instructions:
            gemini_md = gemini_dir / "GEMINI.md"
            gemini_md.write_text(instructions, encoding="utf-8")
            result.paths["systemPromptPath"] = str(gemini_md)

        # (c) settings.json — pre-trust the sandbox workspace, pin the model, and
        # disable telemetry so the TUI surfaces less onboarding friction.
        # Best-effort (agy replaces an invalid settings file with defaults);
        # never clobber an existing one.
        settings_path = cli_dir / "settings.json"
        if not settings_path.exists():
            sandbox_root = os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")
            settings: dict[str, Any] = {
                "trustedWorkspaces": [sandbox_root],
                "enableTelemetry": False,
            }
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
        argv: list[str] = [AGY_BIN, "--dangerously-skip-permissions"]
        model = normalize_agy_model(agent_config.get("modelSpec"))
        if model:
            argv += ["--model", model]
        return argv

    def extract_completion_text(self, payload: Mapping[str, Any]) -> str | None:
        return _text_from_payload(payload)

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
            AGY_AUTH_ENV,  # consumed by seed(); never expose the login bundle
        ):
            env.pop(forbidden, None)
        return env
