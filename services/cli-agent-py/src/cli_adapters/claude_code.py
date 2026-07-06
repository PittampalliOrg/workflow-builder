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
  (d) permissions: CLI sandboxes are already isolated by Kubernetes, so starts
      use ``--dangerously-skip-permissions`` to avoid blocking on tool prompts.
  (e) model: normalize_claude_model copied from claude_sdk_runner.py.
  (g) pane_env: CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_CONFIG_DIR / OTEL_* /
      CLAUDE_CODE_ENABLE_TELEMETRY pass-through + wfb.session.id resource
      attribute; NEVER ANTHROPIC_API_KEY / CLAUDE_API_KEY.

Hook wiring is written PER-SESSION at seed time into
``$CLAUDE_CONFIG_DIR/settings.json`` — NOT baked into the image (the image's
managed-settings.json carries env only). The mirroring events (SessionStart,
PreToolUse, Stop, …) are always registered; the BLOCKING events
(PermissionRequest/PermissionDenied) are registered ONLY for INTERACTIVE
sessions. A one-shot workflow run (``autoTerminateAfterEndTurn``) has no human to
approve a prompt, so it omits them and relies on ``--dangerously-skip-permissions``
(like codex/agy) — a baked PermissionRequest→ask hook otherwise strands it.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Mapping

from src.cli_adapters.base import CliAdapter, SeedResult, link_transcript_subtree
from src.capability_compiler import emit_claude_code_cli_servers, materialize_skills_local
from src.env_flags import CLI_TURN_FAILED_EDGE_ENABLED

logger = logging.getLogger(__name__)

DEFAULT_MODEL = os.environ.get("CLI_AGENT_PY_DEFAULT_MODEL", "claude-opus-4-8")
# Interactive TUI default: "default" (permission prompts surface to the live
# user via the web terminal + blocked-state events) — unlike claude-agent-py's
# headless bypassPermissions default.
DEFAULT_PERMISSION_MODE = os.environ.get("CLI_AGENT_PY_PERMISSION_MODE", "default")
CLI_BIN = os.environ.get("CLI_AGENT_CLI_PATH", "claude")

# Runtime hook wiring (written per-session into $CLAUDE_CONFIG_DIR/settings.json;
# NOT baked into the image). Every claude hook event POSTs to the in-pod hooks
# receiver, which mirrors it to the BFF session-event stream.
HOOK_RELAY_URL = os.environ.get(
    "CLI_AGENT_HOOK_RELAY_URL", "http://127.0.0.1:8002/internal/hooks/claude"
)
# Mirroring/lifecycle events — always-on (event streaming + transcript tailer +
# the DETERMINISTIC ``Stop`` turn-completion edge). These are BAKED into
# docker/managed-settings.json (highest precedence, always enforced) so turn-end
# never falls back to herdr idle detection; this tuple is the canonical list that
# managed-settings.json MUST match (drift-guarded by the adapter tests). Matcher-LESS
# on purpose: a "matcher":"*" entry silently suppressed SessionStart on the live
# ryzen E2E (its matcher domain is startup|resume|clear|compact, not tool names).
_MIRROR_HOOK_EVENTS = (
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "SessionEnd",
    "Notification",
    "PreCompact",
    "PostCompact",
)
# BLOCKING events — surface a permission prompt to the live user + mark the
# session blocked so a human approves in the web terminal. Registered ONLY for
# INTERACTIVE sessions; a one-shot workflow run omits them (no human → it would
# strand) and relies on --dangerously-skip-permissions.
_BLOCKING_HOOK_EVENTS = ("PermissionRequest", "PermissionDenied")
# FAILURE edge — StopFailure fires when a turn ends in error; the receiver raises
# ``turn.failed`` so a one-shot run fails deterministically instead of hanging.
# Unlike Stop/mirroring, StopFailure is NOT baked into managed-settings.json, so it
# must be written per-session here for BOTH one-shot and interactive runs (merges
# with the baked hooks). Follow-up at the next image rebuild: bake it into
# docker/managed-settings.json + drop this per-session write.
_FAILURE_HOOK_EVENTS = ("StopFailure",)
# CLI_TURN_FAILED_EDGE_ENABLED (default ON) is imported from the leaf
# src.env_flags — shared with the hooks receiver without the hooks_api →
# cli_adapters import cycle. When off, the StopFailure relay is not registered.

# Modes the Claude Code CLI's --permission-mode flag accepts.
_CLI_PERMISSION_MODES = {"default", "acceptEdits", "plan", "bypassPermissions"}

# AgentConfig.effort → Claude Code control. The `--effort` FLAG accepts these
# reasoning-effort levels (code.claude.com/docs model-config). `max` is NOT a
# `--effort` value — it is session-only via the CLAUDE_CODE_EFFORT_LEVEL env var
# (set in pane_env). `ultracode` is a Claude Code SETTING (not an effort level),
# enabled via `--settings '{"ultracode": true}'` and NOT combined with --effort.
_CLAUDE_EFFORT_FLAG_VALUES = ("low", "medium", "high", "xhigh")
# The JSON passed to `--settings` to turn on ultracode. argv is exec'd directly
# (no shell), so this JSON string needs no shell quoting. --settings MERGES with
# the baked docker/managed-settings.json (different setting source) rather than
# replacing it, so the managed mirroring/Stop hooks stay intact.
_CLAUDE_ULTRACODE_SETTINGS = '{"ultracode": true}'

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
    # Trust ONLY the rendered composer marker, never herdr's boot-time `idle` — the
    # marker exists precisely because herdr reports `idle` before the composer is
    # drawn, so the idle-status fallback would inject into the boot screen and drop
    # the Enter (same premature-injection class fixed for codex/agy).
    trust_idle_ready_fallback = False
    # Claude Code fires a UserPromptSubmit hook on accept → confirm the kickoff via
    # that deterministic ack (re-press Enter until it fires) instead of screen/status
    # heuristics.
    emits_prompt_submit_hook = True
    # claude's "? for shortcuts" composer marker is undetectable via herdr pane
    # reads (the 180s screen-scrape timeout), so use the deterministic
    # UserPromptSubmit-ack closed-loop instead. Verified: the kickoff submits +
    # the turn runs (gan-harness plan agent reached its turn). codex/agy keep the
    # screen-scrape gate (their markers work + ratatui composer is paste-sensitive).
    kickoff_via_hook_ack = True

    # -- seeding ----------------------------------------------------------------

    def seed(self, session_input: Mapping[str, Any]) -> SeedResult:
        agent_config = _record(session_input.get("agentConfig"))
        result = SeedResult()
        wfb_dir = _wfb_dir()
        wfb_dir.mkdir(parents=True, exist_ok=True)

        # (a) MCP config in Claude Code .mcp.json shape.
        servers = emit_claude_code_cli_servers(agent_config)
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

        # (j) Runtime hook wiring (replaces the baked managed-settings.json hooks):
        # write the relay hooks into settings.json, gating the blocking permission
        # hooks on session type so one-shot workflow runs don't strand.
        self._seed_runtime_hooks(session_input, result)

        return result

    def _seed_runtime_hooks(
        self, session_input: Mapping[str, Any], result: SeedResult
    ) -> None:
        """Write claude's PER-SESSION hook wiring into $CLAUDE_CONFIG_DIR/settings.json.

        The mirroring/lifecycle hooks — including the DETERMINISTIC ``Stop``
        turn-end signal — are BAKED in managed-settings.json (highest precedence,
        always enforced), so turn-completion never depends on herdr idle detection.
        Here we add ONLY the BLOCKING permission hooks
        (PermissionRequest/PermissionDenied), and ONLY for INTERACTIVE sessions: a
        one-shot ``autoTerminateAfterEndTurn`` workflow run has no human to approve,
        so it must NOT register them (relay returns ask/deny → it would strand) and
        relies on --dangerously-skip-permissions. settings.json hooks MERGE with the
        baked managed hooks, so the always-on Stop/mirroring relay keeps firing."""
        import json

        one_shot = bool(session_input.get("autoTerminateAfterEndTurn"))
        entry = [{"hooks": [{"type": "http", "url": HOOK_RELAY_URL}]}]
        # StopFailure (the turn-FAILURE edge) is always registered — for one-shot
        # AND interactive — because it is NOT baked into managed-settings.json. The
        # blocking permission hooks are added ONLY for interactive sessions (a
        # one-shot run has no human → they would strand it).
        hook_events: list[str] = []
        if CLI_TURN_FAILED_EDGE_ENABLED:
            hook_events += list(_FAILURE_HOOK_EVENTS)
        if not one_shot:
            hook_events += list(_BLOCKING_HOOK_EVENTS)

        config_dir = _claude_config_dir()
        config_dir.mkdir(parents=True, exist_ok=True)
        settings_path = config_dir / "settings.json"
        existing: dict[str, Any] = {}
        if settings_path.exists():
            try:
                loaded = json.loads(settings_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    existing = loaded
            except Exception:  # noqa: BLE001 — never fail seeding on a bad file
                existing = {}
        if hook_events:
            # settings.json hooks MERGE with the baked managed mirroring/Stop hooks,
            # so the always-on Stop/mirroring relay keeps firing alongside these.
            existing["hooks"] = {ev: entry for ev in hook_events}
        else:
            # Nothing to add per-session (one-shot with the failure edge disabled) —
            # leave the baked managed mirroring/Stop hooks as the sole wiring.
            existing.pop("hooks", None)
        # Pre-accept the bypass-mode dialog so --dangerously-skip-permissions boots
        # straight into work (claude would otherwise write this itself on first run).
        existing.setdefault("skipDangerousModePermissionPrompt", True)
        settings_path.write_text(json.dumps(existing, indent=2) + "\n", encoding="utf-8")
        result.paths["settingsPath"] = str(settings_path)
        logger.info(
            "[claude] runtime hooks written: events=%s (one_shot=%s; mirroring/Stop baked in managed-settings)",
            hook_events,
            one_shot,
        )

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
        # Match the pane launch cwd (cli_lifecycle._sandbox_root): trust the
        # shared-workspace mount when present so claude has no trust prompt there.
        cwd = (
            os.environ.get("CLI_SHARED_WORKSPACE_MOUNT")
            or os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")
        )
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
        # Delegates to the shared capability compiler (byte-identical) — only the
        # skills root differs per CLI runtime; codex/agy pass their own.
        return materialize_skills_local(
            agent_config, _claude_config_dir() / "skills", warnings
        )

    # -- argv -----------------------------------------------------------------

    def build_argv(
        self,
        agent_config: Mapping[str, Any],
        seed_paths: Mapping[str, str],
        *,
        one_shot: bool = False,
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
        # Fallback model (used when the primary is overloaded). Only when set —
        # normalize_claude_model falls back to DEFAULT_MODEL on empty input, so
        # guard on presence to avoid injecting a spurious fallback.
        if clean_string(agent_config.get("fallbackModelSpec")):
            fallback = normalize_claude_model(agent_config.get("fallbackModelSpec"))
            if fallback:
                argv += ["--fallback-model", fallback]
        # Reasoning effort. `low|medium|high|xhigh` → `--effort <v>`; `ultracode`
        # → `--settings '{"ultracode": true}'` (a setting, not an effort level, so
        # NOT combined with --effort); `max` → the CLAUDE_CODE_EFFORT_LEVEL env in
        # pane_env; unknown/absent → omit (the CLI's own default).
        effort = clean_string(agent_config.get("effort"))
        if effort in _CLAUDE_EFFORT_FLAG_VALUES:
            argv += ["--effort", effort]
        elif effort == "ultracode":
            argv += ["--settings", _CLAUDE_ULTRACODE_SETTINGS]
        # The pod is the isolation boundary for managed CLI sessions; permission
        # prompts otherwise strand unattended workflow runs.
        argv += ["--dangerously-skip-permissions"]
        # A one-shot workflow run is headless — there is no human in the pane to
        # answer an AskUserQuestion prompt, so the tool call blocks forever until
        # the pod's activeDeadline kills it (which also wedges the parent
        # workflow — observed live). Disallow the interactive human-input tool so
        # the model cannot strand on it. Interactive sessions keep it (a human is
        # present to answer). --disallowedTools takes a space-separated list.
        if one_shot:
            argv += ["--disallowedTools", "AskUserQuestion"]
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
        agent_config: Mapping[str, Any] | None = None,
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
            "GITHUB_TOKEN",  # git clone/push + PR for coding workflows (NOT the LLM key)
            "PLAYWRIGHT_BROWSERS_PATH",  # /opt/pw-browsers — the critic's Playwright chromium
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
        # effort=max is session-only via CLAUDE_CODE_EFFORT_LEVEL=max (NOT a
        # --effort flag value). Other effort levels are argv flags (build_argv).
        if agent_config and clean_string(agent_config.get("effort")) == "max":
            env["CLAUDE_CODE_EFFORT_LEVEL"] = "max"
        # NEVER forward API-key auth — it silently outranks the OAuth token and
        # flips billing from subscription to API (startup guard in main.py is
        # the first line of defense; this is the second).
        env.pop("ANTHROPIC_API_KEY", None)
        env.pop("CLAUDE_API_KEY", None)
        return env

    def detect_goal_completion(
        self, entry: Mapping[str, Any]
    ) -> dict[str, Any] | None:
        """Claude's native `/goal` evaluator writes a transcript ``attachment`` of
        ``{type:"goal_status", met:<bool>, condition, reason?}`` after each turn.
        ``met:true`` is the authoritative "goal achieved" signal (the loop stops
        and the session idles). Emit ``session.goal_completed`` once on that row."""
        attachment = entry.get("attachment")
        if not isinstance(attachment, Mapping):
            return None
        if attachment.get("type") != "goal_status" or attachment.get("met") is not True:
            return None
        data: dict[str, Any] = {"completionSource": "claude_transcript_goal"}
        reason = clean_string(attachment.get("reason"))
        if reason:
            data["summary"] = reason
        return data

    def is_turn_failure_hook(self, event_name: str) -> bool:
        """Claude's ``StopFailure`` hook is the authoritative turn-FAILURE edge
        (raised as ``turn.failed``) — the failure counterpart of the ``Stop`` edge."""
        return event_name == "StopFailure"

    # Turn completion is owned EXCLUSIVELY by the Stop hook (base defaults); its
    # failure counterpart is StopFailure (is_turn_failure_hook above). These
    # single-turn autoTerminate runs have no native /goal loop, so a Stop is the
    # authoritative turn-end. The transcript is read only for CONTENT.
