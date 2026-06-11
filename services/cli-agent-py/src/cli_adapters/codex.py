"""Codex CLI TUI adapter (the ``codex-cli`` runtime).

Seeds per-session artifacts and builds the pane argv/env for the real
``codex`` TUI (OpenAI Codex CLI, Rust/ratatui) running in a herdr pane:

  (a) OAuth credential FILE: the user's ChatGPT ``auth.json`` blob is delivered
      to the pod as the ``CODEX_AUTH_JSON`` secret env var (see the
      ``codex-cli`` descriptor ``cliAuth.credentialKind = "file"``). seed()
      materializes it to ``$CODEX_HOME/auth.json`` (chmod 600) so codex reads
      it the same way it would a locally-minted login. Codex auto-refreshes the
      access token from the embedded refresh_token and writes the file back —
      $CODEX_HOME is on the writable sandbox emptyDir, so that works for the
      session lifetime. ChatGPT OAuth OUTRANKS OPENAI_API_KEY for the
      interactive TUI (openai/codex#3286); we both strip the API key from the
      pane env AND set ``forced_login_method = "chatgpt"`` belt-and-braces.
  (b) MCP: agentConfig.mcpServers → codex ``config.toml`` ``[mcp_servers.<name>]``
      tables (stdio: command/args/env; streamable-http: url + http_headers,
      with ``experimental_use_rmcp_client`` enabling the HTTP MCP client).
  (c) system prompt: instructionBundle.rendered.system → ``$CODEX_HOME/AGENTS.md``
      (codex's global instruction file, appended to its base prompt).
  (d) OTEL: when an OTLP endpoint is configured, an ``[otel]`` table points codex's
      log exporter at the collector via the otlp-http struct variant
      (``exporter = { otlp-http = { endpoint, protocol = "binary" } }``); metrics
      are pinned to ``none`` to avoid codex's default external Statsig exporter.

pane_env NEVER forwards OPENAI_API_KEY / CODEX_API_KEY / CODEX_AUTH_JSON (the
blob is consumed by seed() and written to the file — it must not leak into the
pane env where codex would prefer the env credential).
"""

from __future__ import annotations

import json
import logging
import os
import stat
from pathlib import Path
from typing import Any, Mapping

from src.cli_adapters.base import CliAdapter, SeedResult, link_transcript_subtree
from src.mcp_config import build_mcp_servers

logger = logging.getLogger(__name__)

DEFAULT_MODEL = os.environ.get("CLI_AGENT_CODEX_DEFAULT_MODEL", "gpt-5.5")
# Model ids dropped from codex 0.139.0's account catalog. Selecting one fails the
# turn with HTTP 400 "The '<model>' model is not supported when using Codex with a
# ChatGPT account" (and codex warns "model metadata not found"). `gpt-5-codex` was
# this adapter's previous hardcoded default, so existing codex-cli agents are still
# pinned to it — remap any retired id to the current default so they recover
# without a DB migration. (Catalog as of 2026-06: gpt-5.5 / gpt-5.4 / gpt-5.4-mini
# / gpt-5.3-codex-spark.)
RETIRED_CODEX_MODELS = frozenset({"gpt-5-codex"})
DEFAULT_PERMISSION_MODE = os.environ.get("CLI_AGENT_CODEX_PERMISSION_MODE", "default")
CODEX_BIN = os.environ.get("CLI_AGENT_CODEX_PATH", "codex")
# Where the credential blob is delivered (must match descriptor cliAuth.envVar).
CODEX_AUTH_ENV = "CODEX_AUTH_JSON"


def clean_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", "/sandbox/.codex"))


def normalize_codex_model(model_spec: Any) -> str | None:
    """OpenAI Codex models only. A non-OpenAI modelSpec (e.g. anthropic/…) or a
    RETIRED id is ignored so codex falls back to the configured default."""
    raw = clean_string(model_spec)
    candidate: str | None = None
    if raw and raw.startswith("openai/"):
        candidate = raw.split("/", 1)[1]
    elif raw and ("/" not in raw) and not raw.startswith("claude"):
        candidate = raw  # bare model id like "gpt-5.5" / "o4"
    if candidate and candidate not in RETIRED_CODEX_MODELS:
        return candidate
    return clean_string(DEFAULT_MODEL)


# --- TOML emit (no stdlib writer; URLs/headers/commands only) ----------------


def _toml_str(value: str) -> str:
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'


def _toml_key(key: str) -> str:
    if key and all(c.isalnum() or c in "-_" for c in key):
        return key
    return _toml_str(key)


def _toml_inline_table(pairs: Mapping[str, str]) -> str:
    body = ", ".join(f"{_toml_key(k)} = {_toml_str(v)}" for k, v in pairs.items())
    return "{ " + body + " }"


def _toml_array(values: list[str]) -> str:
    return "[" + ", ".join(_toml_str(v) for v in values) + "]"


def _mcp_tables(agent_config: Mapping[str, Any]) -> list[str]:
    """Claude Code .mcp.json shape (from build_mcp_servers) → codex
    [mcp_servers.<name>] tables."""
    servers = build_mcp_servers(agent_config)
    tables: list[str] = []
    for name, cfg in servers.items():
        lines = [f"[mcp_servers.{_toml_key(name)}]"]
        kind = cfg.get("type")
        if kind == "stdio":
            command = clean_string(cfg.get("command"))
            if not command:
                continue
            lines.append(f"command = {_toml_str(command)}")
            args = cfg.get("args")
            if isinstance(args, list) and args:
                lines.append(f"args = {_toml_array([str(a) for a in args])}")
            env = cfg.get("env")
            if isinstance(env, Mapping) and env:
                lines.append(
                    "env = "
                    + _toml_inline_table({str(k): str(v) for k, v in env.items()})
                )
        else:  # http / sse → streamable HTTP
            url = clean_string(cfg.get("url"))
            if not url:
                continue
            lines.append(f"url = {_toml_str(url)}")
            lines.append("experimental_use_rmcp_client = true")
            headers = cfg.get("headers")
            if isinstance(headers, Mapping) and headers:
                lines.append(
                    "http_headers = "
                    + _toml_inline_table({str(k): str(v) for k, v in headers.items()})
                )
        tables.append("\n".join(lines))
    return tables


def _otel_table(base_env: Mapping[str, str]) -> str | None:
    endpoint = clean_string(base_env.get("OTEL_EXPORTER_OTLP_ENDPOINT"))
    if not endpoint:
        return None
    # codex 0.139.0: the [otel] table is `deny_unknown_fields`, and `exporter` is
    # an externally-tagged enum — a unit string ("none"/"statsig") OR a struct
    # variant `{ otlp-http = { endpoint, protocol, headers?, tls? } }` where
    # `protocol` (binary|json) is REQUIRED and `endpoint` lives INSIDE the variant
    # (never at the [otel] level). The log `exporter` endpoint is signal-specific,
    # so append /v1/logs. The metrics default is Statsig (an external OpenAI
    # endpoint) — pin it to "none" so codex only talks to our collector.
    logs_endpoint = _toml_str(endpoint.rstrip("/") + "/v1/logs")
    exporter = f"{{ otlp-http = {{ endpoint = {logs_endpoint}, protocol = \"binary\" }} }}"
    return "\n".join(
        [
            "[otel]",
            'environment = "production"',
            f"exporter = {exporter}",
            'metrics_exporter = "none"',
        ]
    )


def _render_config_toml(agent_config: Mapping[str, Any], base_env: Mapping[str, str]) -> str:
    blocks: list[str] = [
        "# Generated per-session by cli-agent-py CodexAdapter — do not edit.",
        # Keep ChatGPT OAuth authoritative even if an API key leaks into env.
        'forced_login_method = "chatgpt"',
    ]
    otel = _otel_table(base_env)
    if otel:
        blocks.append(otel)
    blocks.extend(_mcp_tables(agent_config))
    return "\n\n".join(blocks) + "\n"


class CodexAdapter(CliAdapter):
    name = "codex"

    # -- seeding ----------------------------------------------------------------

    def seed(self, session_input: Mapping[str, Any]) -> SeedResult:
        agent_config = _record(session_input.get("agentConfig"))
        result = SeedResult()
        home = _codex_home()
        home.mkdir(parents=True, exist_ok=True)

        # (a) OAuth credential file from the delivered blob.
        self._materialize_auth(result)

        # (b)+(d) config.toml (forced_login_method + MCP + OTEL).
        config_path = home / "config.toml"
        config_path.write_text(
            _render_config_toml(agent_config, os.environ), encoding="utf-8"
        )
        result.paths["codexConfigPath"] = str(config_path)

        # (c) system prompt → AGENTS.md (codex's global instruction file).
        bundle = _record(session_input.get("instructionBundle"))
        rendered = _record(bundle.get("rendered"))
        system_text = clean_string(rendered.get("system"))
        if system_text:
            agents_path = home / "AGENTS.md"
            agents_path.write_text(system_text + "\n", encoding="utf-8")
            result.paths["systemPromptPath"] = str(agents_path)

        # (e) Durable transcript store. codex persists threads as rollout files
        # under $CODEX_HOME/sessions; redirect that dir into the per-session
        # JuiceFS subtree (CLI_TRANSCRIPT_MOUNT) so the conversation persists to
        # Postgres and `codex resume --last` works across pods. No-op otherwise.
        linked = link_transcript_subtree(home / "sessions", "codex")
        if linked:
            result.paths["transcriptStore"] = linked

        return result

    def _materialize_auth(self, result: SeedResult) -> None:
        blob = os.environ.get(CODEX_AUTH_ENV)
        home = _codex_home()
        auth_path = home / "auth.json"
        if auth_path.exists():
            return  # codex's own refreshed file — never clobber
        if not blob or not blob.strip():
            result.warnings.append(
                "codex: no CODEX_AUTH_JSON delivered — the TUI will prompt for login"
            )
            return
        text = blob.strip()
        try:
            json.loads(text)  # validate; write verbatim either way
        except ValueError:
            result.warnings.append("codex: CODEX_AUTH_JSON is not valid JSON")
        auth_path.write_text(text + "\n", encoding="utf-8")
        try:
            auth_path.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 0600
        except OSError:
            pass
        result.paths["codexAuthPath"] = str(auth_path)

    # -- argv -----------------------------------------------------------------

    def build_argv(
        self, agent_config: Mapping[str, Any], seed_paths: Mapping[str, str]
    ) -> list[str]:
        argv: list[str] = [CODEX_BIN]
        # Resume: the re-mounted $CODEX_HOME/sessions subtree holds the prior
        # rollouts, so `codex resume --last` continues the most-recent thread
        # (no thread id needed; codex merges the TUI flags below into resume).
        if bool(agent_config.get("continueSession")):
            argv += ["resume", "--last"]
        argv += ["--cd", os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")]
        model = normalize_codex_model(agent_config.get("modelSpec"))
        if model:
            argv += ["--model", model]
        # Sandbox/approval mapping. The K8s pod is the real isolation boundary,
        # so codex's own landlock sandbox is disabled (danger-full-access);
        # approvals still surface to the live user in the TUI (on-request).
        mode = clean_string(agent_config.get("permissionMode")) or DEFAULT_PERMISSION_MODE
        if mode in {"bypass", "bypassPermissions", "dontAsk", "auto"}:
            argv += ["--dangerously-bypass-approvals-and-sandbox"]
        elif mode == "plan":
            argv += ["--sandbox", "read-only", "--ask-for-approval", "untrusted"]
        else:
            argv += ["--sandbox", "danger-full-access", "--ask-for-approval", "on-request"]
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
            "CODEX_HOME",
            "HOME",
            "PATH",
            "TERM",
            "RUST_LOG",
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
        # NEVER forward API-key auth or the credential blob — codex prefers an
        # env credential over the auth.json file, which would bypass the user's
        # ChatGPT subscription. The blob is consumed by seed() only.
        for forbidden in (
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            CODEX_AUTH_ENV,
            "ANTHROPIC_API_KEY",
            "CLAUDE_API_KEY",
        ):
            env.pop(forbidden, None)
        return env
