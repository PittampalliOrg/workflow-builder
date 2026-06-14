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

from src.cli_adapters.base import (
    CliAdapter,
    SeedResult,
    hook_relay_command,
    link_transcript_subtree,
    write_hook_relay_script,
)
from src.capability_compiler import (
    compose_instruction_file,
    emit_claude_code_cli_servers,
    materialize_skills_local,
    render_skills_index,
)

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


def _hook_relay_path() -> Path:
    root = os.environ.get("CLI_AGENT_WFB_DIR")
    if root:
        return Path(root) / "wfb_hook_relay.py"
    return (
        Path(os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox"))
        / ".wfb"
        / "wfb_hook_relay.py"
    )


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
    servers = emit_claude_code_cli_servers(agent_config)
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


def _sandbox_cwd(base_env: Mapping[str, str]) -> str:
    """The directory codex is launched in (build_argv's --cd)."""
    return clean_string(base_env.get("AGENT_LOCAL_SANDBOX_ROOT")) or "/sandbox"


def _trusted_project_table(base_env: Mapping[str, str]) -> str:
    """Pre-trust the sandbox cwd. codex 0.139.0 shows a BLOCKING onboarding
    prompt ("Do you trust the contents of this directory?") for any cwd that
    isn't already trusted; the readiness-gated seed REFUSES to type into that
    blocked dialog, so the session start-stalls and terminates before codex ever
    reaches its composer. Marking the cwd `trusted` in config.toml (the same
    record the TUI writes when you pick "Yes, continue") makes codex boot
    straight to the prompt. The pod is the real isolation boundary, so trusting
    the sandbox dir is safe."""
    return "\n".join(
        [
            f"[projects.{_toml_str(_sandbox_cwd(base_env))}]",
            'trust_level = "trusted"',
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
    blocks.append(_trusted_project_table(base_env))
    blocks.extend(_mcp_tables(agent_config))
    return "\n\n".join(blocks) + "\n"


def _codex_hook_group(event: str, *, matcher: str | None = None) -> list[dict[str, Any]]:
    relay = _hook_relay_path()
    group: dict[str, Any] = {
        "hooks": [
            {
                "type": "command",
                "command": hook_relay_command(relay, adapter="codex", event=event),
                "timeout": 30,
                "statusMessage": f"Recording {event}",
            }
        ]
    }
    if matcher is not None:
        group["matcher"] = matcher
    return [group]


def _render_hooks_json() -> str:
    # Codex hook schema is {hooks: {Event: [{matcher?, hooks: [...]}]}}.
    # Stop/UserPromptSubmit ignore matchers per the docs; tool/permission events
    # use "*" to cover every built-in/MCP tool.
    payload = {
        "hooks": {
            "SessionStart": _codex_hook_group(
                "SessionStart", matcher="startup|resume|clear|compact"
            ),
            "UserPromptSubmit": _codex_hook_group("UserPromptSubmit"),
            "PreToolUse": _codex_hook_group("PreToolUse", matcher="*"),
            "PermissionRequest": _codex_hook_group("PermissionRequest", matcher="*"),
            "PostToolUse": _codex_hook_group("PostToolUse", matcher="*"),
            "Stop": _codex_hook_group("Stop"),
        }
    }
    return json.dumps(payload, indent=2) + "\n"


def _hook_name(payload: Mapping[str, Any]) -> str | None:
    for key in ("hook_event_name", "eventName", "event", "hookName", "name"):
        picked = clean_string(payload.get(key))
        if picked:
            return picked
    return None


def _hook_tool_name(payload: Mapping[str, Any]) -> str | None:
    return clean_string(payload.get("tool_name") or payload.get("toolName"))


def _is_mcp_hook_tool_name(value: str | None) -> bool:
    return bool(value and value.startswith("mcp__"))


def _text_from_content(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str) and item.strip():
                parts.append(item.strip())
            elif isinstance(item, Mapping):
                text = item.get("text") or item.get("content")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
        if parts:
            return "\n\n".join(parts)
    if isinstance(value, Mapping):
        for key in ("text", "content", "message", "output"):
            text = _text_from_content(value.get(key))
            if text:
                return text
    return None


def _codex_payload(record: Mapping[str, Any]) -> Mapping[str, Any] | None:
    if record.get("type") != "event_msg":
        return None
    payload = record.get("payload")
    return payload if isinstance(payload, Mapping) else None


def _codex_event_identity(record: Mapping[str, Any], payload: Mapping[str, Any]) -> str | None:
    for key in ("turn_id", "call_id", "submission_id", "id"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    timestamp = record.get("timestamp")
    event_type = payload.get("type")
    if isinstance(timestamp, str) and timestamp.strip() and isinstance(event_type, str):
        return f"{event_type}:{timestamp.strip()}"
    return None


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _codex_usage(payload: Mapping[str, Any]) -> dict[str, Any] | None:
    if payload.get("type") != "token_count":
        return None
    info = payload.get("info")
    if not isinstance(info, Mapping):
        return None
    usage = info.get("last_token_usage") or info.get("total_token_usage")
    if not isinstance(usage, Mapping):
        return None
    gross_input = _int_or_none(usage.get("input_tokens"))
    cache_read = _int_or_none(
        usage.get("cached_input_tokens") or usage.get("cache_read_input_tokens")
    )
    output_tokens = _int_or_none(usage.get("output_tokens"))
    reasoning_tokens = _int_or_none(usage.get("reasoning_output_tokens"))
    data: dict[str, Any] = {
        # Codex's rollout usage reports gross input + cached input separately.
        # Mirror the platform invariant used by the other runtimes: input_tokens
        # is NET of cache reads, while cache_read_input_tokens carries the cache.
        "input_tokens": (
            max(0, gross_input - (cache_read or 0)) if gross_input is not None else None
        ),
        "output_tokens": output_tokens,
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": 0,
        "reasoning_output_tokens": reasoning_tokens,
    }
    context_window = _int_or_none(info.get("model_context_window"))
    if context_window is not None:
        data["model_context_window"] = context_window
    rate_limits = payload.get("rate_limits")
    if isinstance(rate_limits, Mapping):
        plan_type = clean_string(rate_limits.get("plan_type"))
        if plan_type:
            data["plan_type"] = plan_type
    if not any(value is not None for value in data.values()):
        return None
    return data


def _codex_mcp_tool_name(payload: Mapping[str, Any]) -> str:
    invocation = payload.get("invocation")
    invocation = invocation if isinstance(invocation, Mapping) else {}
    server = clean_string(invocation.get("server")) or "mcp_server"
    tool = clean_string(invocation.get("tool")) or "tool"
    server = "".join(ch if ch.isalnum() else "_" for ch in server).strip("_") or "mcp_server"
    tool = "".join(ch if ch.isalnum() or ch in {"_", "-"} else "_" for ch in tool).strip("_") or "tool"
    return f"mcp__{server}__{tool}"


def _text_from_mcp_content(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, Mapping):
                text = item.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
            elif isinstance(item, str) and item.strip():
                parts.append(item.strip())
        if parts:
            return "\n".join(parts)
    return None


def _codex_mcp_result_payload(payload: Mapping[str, Any]) -> dict[str, Any] | None:
    if payload.get("type") != "mcp_tool_call_end":
        return None
    invocation = payload.get("invocation")
    invocation = invocation if isinstance(invocation, Mapping) else {}
    result = payload.get("result")
    result = result if isinstance(result, Mapping) else {}

    ok_payload = result.get("Ok")
    err_payload = result.get("Err")
    success = err_payload is None
    raw: Any = ok_payload if success else err_payload
    if isinstance(ok_payload, Mapping) and ok_payload.get("isError") is True:
        success = False

    output = None
    if isinstance(raw, Mapping):
        output = _text_from_mcp_content(raw.get("content"))
        if output is None:
            output = _text_from_content(raw.get("message") or raw.get("error"))
    else:
        output = _text_from_content(raw)
    if output is None and raw is not None:
        try:
            output = json.dumps(raw, ensure_ascii=False)
        except TypeError:
            output = str(raw)

    tool_name = _codex_mcp_tool_name(payload)
    data: dict[str, Any] = {
        "tool_name": tool_name,
        "name": tool_name,
        "ok": success,
        "success": success,
        "output": output or "",
        "output_preview": (output or "")[:500],
    }
    call_id = clean_string(payload.get("call_id"))
    if call_id:
        data["call_id"] = call_id
    arguments = invocation.get("arguments")
    if isinstance(arguments, Mapping):
        data["tool_input"] = dict(arguments)
        data["input"] = dict(arguments)
    server = clean_string(invocation.get("server"))
    tool = clean_string(invocation.get("tool"))
    if server:
        data["server"] = server
    if tool:
        data["mcp_tool"] = tool
    duration = payload.get("duration")
    if isinstance(duration, Mapping):
        data["duration"] = dict(duration)
    if not success:
        data["is_error"] = True
        data["error"] = output or "MCP tool failed"
    return data


def _assistant_text_from_record(record: Mapping[str, Any]) -> str | None:
    codex_payload = _codex_payload(record)
    if codex_payload is not None:
        if codex_payload.get("type") == "task_complete":
            text = _text_from_content(codex_payload.get("last_agent_message"))
            if text:
                return text
        if codex_payload.get("type") == "agent_message":
            text = _text_from_content(codex_payload.get("message"))
            if text:
                return text
    role = record.get("role")
    if role == "assistant":
        text = _text_from_content(record.get("content") or record.get("message"))
        if text:
            return text
    if record.get("type") == "assistant":
        text = _text_from_content(record.get("message") or record.get("content"))
        if text:
            return text
    payload = record.get("payload")
    if isinstance(payload, Mapping):
        text = _assistant_text_from_record(payload)
        if text:
            return text
    if record.get("type") == "message" and record.get("role") == "assistant":
        text = _text_from_content(record.get("content"))
        if text:
            return text
    if record.get("type") in {"turn.completed", "turn_completed"}:
        for key in ("final_message", "message", "content", "output"):
            text = _text_from_content(record.get(key))
            if text:
                return text
    return None


def _latest_codex_assistant_text() -> str | None:
    sessions = _codex_home() / "sessions"
    if not sessions.exists():
        return None
    files = sorted(
        (p for p in sessions.rglob("*.jsonl") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for path in files[:5]:
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in reversed(lines[-400:]):
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if isinstance(record, Mapping):
                text = _assistant_text_from_record(record)
                if text:
                    return text
    return None


class CodexAdapter(CliAdapter):
    name = "codex"
    # Codex command hooks report UserPromptSubmit, but its ratatui composer eats
    # a leading zero-width run + the first token, so INJECTION_MARKER must NOT be
    # prefixed. The hook confirms turn-start for injected prompts while skipping
    # duplicate user.message rows by digest.
    uses_injection_marker = False
    hook_reports_prompt_submit = True
    # Content-gate the kickoff on the rendered composer: herdr's native codex
    # detector races and can report `idle` while codex is still on its
    # pre-composer welcome/banner screen, so an agent_status-gated seed strands
    # ABOVE the banner (observed intermittently — e.g. on the dapr-1.18 ryzen
    # canary). The idle composer's status footer is `<model> <profile> · <cwd>`
    # (e.g. `gpt-5.5 default · /sandbox`); the `· <cwd>` segment is rendered ONLY
    # with the composer (the boot banner writes `directory: /sandbox`, no middle
    # dot) and is independent of model/permission-mode (unlike `default`, which
    # becomes `untrusted` in plan mode). cwd is always AGENT_LOCAL_SANDBOX_ROOT
    # (/sandbox), so `· /sandbox` is a stable "composer is drawn" marker. On gate
    # timeout the lifecycle still injects best-effort (degrades to the old
    # behavior, never worse).
    prompt_ready_marker = "· /sandbox"

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

        # (b2) Hook relay: Codex discovers hooks.json next to config.toml.
        relay = write_hook_relay_script(_hook_relay_path())
        hooks_path = home / "hooks.json"
        hooks_path.write_text(_render_hooks_json(), encoding="utf-8")
        result.paths["hookRelayPath"] = str(relay)
        result.paths["hooksPath"] = str(hooks_path)

        # (c) skills → $CODEX_HOME/skills/<slug>/ ; system prompt + a skills
        # index → AGENTS.md. codex has no native skills auto-discovery, so the
        # index (a delimited block, REWRITTEN each seed so a pod restart can't
        # double-append) tells the model which skills exist + where their
        # SKILL.md lives. With no skills this reduces to the prior
        # system-prompt-only write (byte-identical).
        materialize_skills_local(agent_config, home / "skills", result.warnings)
        bundle = _record(session_input.get("instructionBundle"))
        rendered = _record(bundle.get("rendered"))
        instructions = compose_instruction_file(
            rendered.get("system"), render_skills_index(agent_config)
        )
        if instructions:
            agents_path = home / "AGENTS.md"
            agents_path.write_text(instructions, encoding="utf-8")
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
        argv: list[str] = [CODEX_BIN, "--dangerously-bypass-hook-trust", "--yolo"]
        # Resume: the re-mounted $CODEX_HOME/sessions subtree holds the prior
        # rollouts, so `codex resume --last` continues the most-recent thread
        # (no thread id needed; codex merges the TUI flags below into resume).
        if bool(agent_config.get("continueSession")):
            argv += ["resume", "--last"]
        argv += ["--cd", os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")]
        model = normalize_codex_model(agent_config.get("modelSpec"))
        if model:
            argv += ["--model", model]
        return argv

    def extract_completion_text(self, payload: Mapping[str, Any]) -> str | None:
        text = _text_from_content(
            payload.get("lastAssistantText")
            or payload.get("finalResponse")
            or payload.get("response")
            or payload.get("content")
        )
        return text or _latest_codex_assistant_text()

    def map_transcript_entry(
        self, entry: Mapping[str, Any]
    ) -> list[dict[str, Any]] | None:
        payload = _codex_payload(entry)
        if payload is None:
            return None
        events: list[dict[str, Any]] = []
        identity = _codex_event_identity(entry, payload)
        event_type = payload.get("type")
        if event_type == "agent_message":
            text = _text_from_content(payload.get("message"))
            if text:
                data: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
                phase = clean_string(payload.get("phase"))
                if phase:
                    data["phase"] = phase
                event: dict[str, Any] = {"type": "agent.message", "data": data}
                if identity:
                    event["sourceEventId"] = f"codex-transcript:{identity}:message"
                events.append(event)
        usage = _codex_usage(payload)
        if usage:
            event = {"type": "agent.llm_usage", "data": usage}
            if identity:
                event["sourceEventId"] = f"codex-transcript:{identity}:usage"
            events.append(event)
        tool_result = _codex_mcp_result_payload(payload)
        if tool_result:
            event = {"type": "agent.tool_result", "data": tool_result}
            if identity:
                event["sourceEventId"] = f"codex-transcript:{identity}:tool_result"
            events.append(event)
        return events

    def map_hook_event(self, payload: Mapping[str, Any]) -> list[dict[str, Any]] | None:
        name = _hook_name(payload)
        tool_name = _hook_tool_name(payload)
        if name in {"PostToolUse", "PostToolUseFailure"} and _is_mcp_hook_tool_name(
            tool_name
        ):
            # Codex records MCP completion with richer call_id/server/duration data
            # in the transcript as mcp_tool_call_end. Let the transcript be
            # authoritative and keep the hook path for tool starts only.
            return []
        return None

    def transcript_turn_completion(self, entry: Mapping[str, Any]) -> dict[str, Any] | None:
        payload = _codex_payload(entry)
        if payload is None or payload.get("type") != "task_complete":
            return None
        event: dict[str, Any] = {
            "type": "turn.completed",
            "completionSource": "codex_task_complete",
        }
        turn_id = clean_string(payload.get("turn_id"))
        if turn_id:
            event["turnId"] = turn_id
        text = _text_from_content(payload.get("last_agent_message"))
        if text:
            event["lastAssistantText"] = text
        return event

    def stop_hook_completes_turn(self) -> bool:
        # Codex emits an authoritative `task_complete` rollout entry before the
        # Stop hook. Completing from both sources creates duplicate platform
        # turns and can leave direct sessions stuck in running.
        return False

    def is_turn_completion_hook(self, event_name: str) -> bool:
        return False

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
