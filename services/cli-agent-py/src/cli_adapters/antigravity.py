"""Antigravity CLI (``agy``) TUI adapter (the ``agy-cli`` runtime).

``agy`` is Google's Antigravity CLI (a Go/Codeium-"jetski" rewrite that
supersedes Gemini CLI). Auth is file-bundle OAuth: a first launch can still use
in-pane device-code login, but once the user signs in, ``agy_capture`` persists
the curated ``~/.gemini`` login files and future pods restore them through
``AGY_AUTH_JSON`` before the TUI starts.

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
import signal
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Mapping

from src.agy_capture import restore_bundle, start_capture_watcher
from src.agy_stop_guard import (
    evaluate_stop_guard,
    has_stop_guard_config,
    write_stop_guard_config,
)
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
RUN_COMMAND_SHIM_MAX_OUTPUT = 16_000
RUN_COMMAND_SHIM_REASON_LIMIT = 9_000
RUN_COMMAND_SHIM_DEFAULT_TIMEOUT_SECONDS = 300
RUN_COMMAND_SHIM_KILL_GRACE_SECONDS = 2.0
DEFAULT_AGY_MCP_DENYLIST = frozenset(
    {
        # AGY currently stalls response streaming when these ActivePieces MCP
        # services are present in mcp_config.json, even if the prompt never uses
        # their tools. Keep them out by default until their MCP/SSE readiness is
        # fixed for AGY.
        "piece_microsoft-onedrive",
        "piece_microsoft_onedrive",
        "piece_microsoft-todo",
        "piece_microsoft_todo",
    }
)


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
    if raw and "/" in raw:
        provider, model = raw.split("/", 1)
        if provider in {"gemini", "google", "googleai"} and model.startswith("gemini"):
            return model
    if raw and raw.lower().startswith("gemini"):
        return raw
    return clean_string(DEFAULT_MODEL)


def _csv_env_set(name: str, default: frozenset[str] | None = None) -> frozenset[str]:
    raw = os.environ.get(name)
    if raw is None:
        return default or frozenset()
    return frozenset(item.strip().lower() for item in raw.split(",") if item.strip())


def _agy_mcp_filter_reason(name: str) -> str | None:
    normalized = name.strip().lower()
    allowlist = _csv_env_set("CLI_AGENT_AGY_MCP_ALLOWLIST")
    if allowlist and normalized not in allowlist:
        return "not present in CLI_AGENT_AGY_MCP_ALLOWLIST"
    denylist = _csv_env_set("CLI_AGENT_AGY_MCP_DENYLIST", DEFAULT_AGY_MCP_DENYLIST)
    if normalized in denylist:
        return "disabled for AGY by CLI_AGENT_AGY_MCP_DENYLIST"
    return None


def _agy_mcp_servers(
    agent_config: Mapping[str, Any], warnings: list[str] | None = None
) -> dict[str, dict[str, Any]]:
    """Claude Code .mcp.json shape (from build_mcp_servers) → agy mcp_config.json
    server map. Remote servers use ``serverUrl`` (agy's required key)."""
    servers = emit_claude_code_cli_servers(agent_config)
    out: dict[str, dict[str, Any]] = {}
    for name, cfg in servers.items():
        filter_reason = _agy_mcp_filter_reason(name)
        if filter_reason:
            if warnings is not None:
                warnings.append(
                    f"agy: skipped MCP server {name!r}: {filter_reason}"
                )
            continue
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


def _merge_unique_strings(existing: Any, additions: list[str]) -> list[str]:
    values: list[str] = []
    if isinstance(existing, list):
        values.extend(str(item) for item in existing if str(item).strip())
    values.extend(additions)
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        clean = str(value).strip()
        if not clean or clean in seen:
            continue
        seen.add(clean)
        out.append(clean)
    return out


def _read_settings(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return dict(parsed) if isinstance(parsed, Mapping) else {}


def _managed_agy_settings(
    existing: Mapping[str, Any], agent_config: Mapping[str, Any]
) -> dict[str, Any]:
    """Merge unattended workflow-builder settings into a restored AGY profile.

    The auth bundle can include the user's local settings.json. In managed
    sandbox pods, permission prompts strand durable workflows, so these runtime
    keys are intentionally owned by workflow-builder on every seed.
    """
    sandbox_root = os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")
    settings = dict(existing)
    settings.update(
        {
            "enableTelemetry": False,
            "toolPermission": "always-proceed",
            "artifactReviewPolicy": "always-proceed",
            "allowNonWorkspaceAccess": True,
            # Antigravity shares VS Code's terminal settings surface. After some
            # updates a null default profile or shell-integration PTY state can
            # strand Bash tool calls in RUNNING, so pin the managed Linux shell
            # shape for headless pods.
            "terminal.integrated.shellIntegration.enabled": False,
            "terminal.integrated.defaultProfile.linux": "bash",
            "terminal.integrated.profiles.linux": {
                "bash": {"path": "/bin/bash"},
            },
            # The Kubernetes Sandbox pod is the containment boundary here.
            # AGY's nested nsjail/sandbox mode can require host privileges that
            # are unavailable in our agent-host pod and is redundant for this
            # managed runtime.
            "enableTerminalSandbox": False,
        }
    )
    settings["trustedWorkspaces"] = _merge_unique_strings(
        settings.get("trustedWorkspaces"), [sandbox_root]
    )
    settings["permissions"] = {
        "allow": [
            "command(*)",
            f"read_file({sandbox_root})",
            f"write_file({sandbox_root})",
            "read_url(*)",
            "execute_url(*)",
            "mcp(*)",
        ],
        "deny": [],
        "ask": [],
    }
    model = normalize_agy_model(agent_config.get("modelSpec"))
    if model:
        settings["model"] = model
    return settings


def _agy_hook_group(event: str, *, matcher: str | None = None) -> list[dict[str, Any]]:
    group: dict[str, Any] = {
        "hooks": [_agy_hook_handler(event)]
    }
    if matcher is not None:
        group["matcher"] = matcher
    return [group]


def _agy_hook_handler(event: str) -> dict[str, Any]:
    return {
        "type": "command",
        "command": hook_relay_command(
            _hook_relay_path(), adapter="antigravity", event=event
        ),
    }


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
            "Stop": [_agy_hook_handler("Stop")],
            "SessionEnd": _agy_hook_group("SessionEnd"),
            # dapr-agent-py parity: notification, permission-denied, and
            # context-compaction telemetry.
            "Notification": _agy_hook_group("Notification"),
            "PermissionDenied": _agy_hook_group("PermissionDenied", matcher="*"),
            "PreCompact": _agy_hook_group("PreCompact"),
            "PostCompact": _agy_hook_group("PostCompact"),
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


_HOOK_EVENT_NAMES = {
    "Notification",
    "PermissionDenied",
    "PermissionRequest",
    "PostCompact",
    "PostToolUse",
    "PostToolUseFailure",
    "PreCompact",
    "PreToolUse",
    "SessionEnd",
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
}


def _hook_name(payload: Mapping[str, Any]) -> str | None:
    for key in ("hook_event_name", "eventName", "event", "hookName", "name"):
        picked = clean_string(payload.get(key))
        if picked:
            return picked
    return None


def _tool_record(payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    for key in (
        "tool_call",
        "toolCall",
        "toolUse",
        "tool_use",
        "functionCall",
        "function_call",
        "call",
        "request",
    ):
        value = payload.get(key)
        if isinstance(value, Mapping):
            return value
    tool = payload.get("tool")
    if isinstance(tool, Mapping):
        return tool
    return None


def _result_record(payload: Mapping[str, Any]) -> Mapping[str, Any] | None:
    for key in (
        "tool_result",
        "toolResult",
        "tool_response",
        "toolResponse",
        "functionResponse",
        "function_response",
        "response",
        "result",
        "observation",
    ):
        value = payload.get(key)
        if isinstance(value, Mapping):
            return value
    return None


def _tool_name_from(payload: Mapping[str, Any]) -> str | None:
    for record in (payload, _tool_record(payload), _result_record(payload)):
        if not isinstance(record, Mapping):
            continue
        for key in (
            "tool_name",
            "toolName",
            "name",
            "displayName",
            "function_name",
            "functionName",
            "command",
        ):
            name = clean_string(record.get(key))
            if name and name not in _HOOK_EVENT_NAMES:
                return name
    return None


def _canonical_tool_name(tool_name: str, tool_input: Mapping[str, Any]) -> str:
    if tool_name != "call_mcp_tool":
        return tool_name
    server = clean_string(
        tool_input.get("ServerName")
        or tool_input.get("serverName")
        or tool_input.get("server_name")
        or tool_input.get("server")
    )
    tool = clean_string(
        tool_input.get("ToolName")
        or tool_input.get("toolName")
        or tool_input.get("tool_name")
        or tool_input.get("name")
    )
    if server and tool:
        return f"mcp__{server}__{tool}"
    return tool_name


def _mcp_tool_metadata(tool_name: str) -> dict[str, str]:
    if not tool_name.startswith("mcp__"):
        return {}
    parts = tool_name.split("__", 2)
    if len(parts) != 3 or not parts[1] or not parts[2]:
        return {}
    return {"server": parts[1], "mcp_tool": parts[2]}


def _jsonish_mapping(value: Any) -> dict[str, Any] | None:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str) and value.strip().startswith("{"):
        try:
            parsed = json.loads(value)
        except ValueError:
            return None
        if isinstance(parsed, Mapping):
            return dict(parsed)
    return None


def _tool_input_from(payload: Mapping[str, Any]) -> dict[str, Any]:
    for record in (payload, _tool_record(payload)):
        if not isinstance(record, Mapping):
            continue
        for key in (
            "tool_input",
            "toolInput",
            "input",
            "args",
            "arguments",
            "params",
            "parameters",
        ):
            if key not in record:
                continue
            mapped = _jsonish_mapping(record.get(key))
            if mapped is not None:
                return mapped
            value = record.get(key)
            if value is None:
                return {}
            return {"value": value}
    return {}


def _tool_output_from(payload: Mapping[str, Any]) -> str:
    for record in (payload, _result_record(payload)):
        if not isinstance(record, Mapping):
            continue
        for key in (
            "tool_response",
            "toolResponse",
            "output",
            "result",
            "response",
            "content",
            "observation",
            "text",
        ):
            if key not in record:
                continue
            text = _text_from_payload(record.get(key))
            if text:
                return text
            value = record.get(key)
            if value is not None:
                try:
                    return json.dumps(value)
                except (TypeError, ValueError):
                    return str(value)
    return ""


def _env_bool(name: str, default: bool | None = None) -> bool | None:
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _user_namespaces_available() -> bool:
    try:
        raw = Path("/proc/sys/user/max_user_namespaces").read_text(encoding="utf-8")
        return int(raw.strip()) > 0
    except (OSError, TypeError, ValueError):
        # If the probe is unavailable, avoid changing native AGY behavior unless
        # the operator explicitly enables the shim.
        return True


def _should_shim_run_command() -> bool:
    explicit = _env_bool("CLI_AGENT_AGY_RUN_COMMAND_SHIM")
    if explicit is not None:
        return explicit
    return not _user_namespaces_available()


def _run_command_value(tool_input: Mapping[str, Any]) -> str | None:
    for key in ("CommandLine", "commandLine", "command", "Command", "cmd"):
        value = clean_string(tool_input.get(key))
        if value:
            return value
    return None


def _bash_argv(command: str) -> list[str]:
    return [shutil.which("bash") or "/bin/bash", "-lc", command]


def _safe_command_cwd(tool_input: Mapping[str, Any]) -> Path | None:
    sandbox_root = Path(os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")).resolve()
    raw = (
        clean_string(tool_input.get("Cwd"))
        or clean_string(tool_input.get("cwd"))
        or clean_string(tool_input.get("workingDirectory"))
        or str(sandbox_root)
    )
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = sandbox_root / candidate
    try:
        resolved = candidate.resolve()
        resolved.relative_to(sandbox_root)
    except (OSError, ValueError):
        return None
    return resolved


def _truncate_text(value: str, limit: int = RUN_COMMAND_SHIM_MAX_OUTPUT) -> str:
    if len(value) <= limit:
        return value
    omitted = len(value) - limit
    return value[:limit] + f"\n...[truncated {omitted} chars]"


def _terminate_process_group(proc: subprocess.Popen[str]) -> None:
    try:
        pgid = os.getpgid(proc.pid)
    except Exception:  # noqa: BLE001
        pgid = None
    if pgid is not None:
        try:
            os.killpg(pgid, signal.SIGTERM)
            return
        except ProcessLookupError:
            return
        except Exception:  # noqa: BLE001
            pass
    try:
        proc.terminate()
    except Exception:  # noqa: BLE001
        pass


def _kill_process_group(proc: subprocess.Popen[str]) -> None:
    try:
        pgid = os.getpgid(proc.pid)
    except Exception:  # noqa: BLE001
        pgid = None
    if pgid is not None:
        try:
            os.killpg(pgid, signal.SIGKILL)
            return
        except ProcessLookupError:
            return
        except Exception:  # noqa: BLE001
            pass
    try:
        proc.kill()
    except Exception:  # noqa: BLE001
        pass


def _run_bash_command(command: str, cwd: Path, timeout: int) -> dict[str, Any]:
    started = time.monotonic()
    proc = subprocess.Popen(
        _bash_argv(command),
        cwd=str(cwd),
        env=os.environ.copy(),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
        return {
            "exit_code": proc.returncode,
            "timed_out": False,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "stdout": _truncate_text(stdout or ""),
            "stderr": _truncate_text(stderr or ""),
        }
    except subprocess.TimeoutExpired as exc:
        _terminate_process_group(proc)
        try:
            stdout, stderr = proc.communicate(timeout=RUN_COMMAND_SHIM_KILL_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            _kill_process_group(proc)
            stdout, stderr = proc.communicate()
        stdout_text = stdout if stdout is not None else exc.stdout or ""
        stderr_text = stderr if stderr is not None else exc.stderr or ""
        return {
            "exit_code": 124,
            "timed_out": True,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "stdout": _truncate_text(stdout_text),
            "stderr": _truncate_text(
                stderr_text + f"\nCommand timed out after {timeout} seconds."
            ),
        }


def _format_run_command_reason(result: Mapping[str, Any]) -> str:
    stdout = str(result.get("stdout") or "")
    stderr = str(result.get("stderr") or "")
    reason = (
        "Workflow-builder executed this run_command in the managed sandbox and "
        "blocked AGY's native terminal executor for this call. Treat the "
        "captured result below as the Bash tool result; do not retry the same "
        "command unless the user asks.\n"
        f"Exit code: {result.get('exit_code')}\n"
        f"stdout:\n{stdout}\n"
        f"stderr:\n{stderr}"
    )
    return _truncate_text(reason, RUN_COMMAND_SHIM_REASON_LIMIT)


def _run_command_shim_event(
    tool_input: Mapping[str, Any], result: Mapping[str, Any], output: str
) -> dict[str, Any]:
    ok = result.get("exit_code") == 0 and not result.get("timed_out")
    return {
        "type": "agent.tool_result",
        "data": {
            "tool_name": "run_command",
            "name": "run_command",
            "ok": ok,
            "success": ok,
            "is_error": not ok,
            "exit_code": result.get("exit_code"),
            "timed_out": bool(result.get("timed_out")),
            "duration_ms": result.get("duration_ms"),
            "output": output,
            "output_preview": output[:500],
            "stdout": result.get("stdout") or "",
            "stderr": result.get("stderr") or "",
            "tool_input": dict(tool_input),
            "input": dict(tool_input),
            "shim": "agy-run-command-hook",
        },
    }


def _execute_run_command_shim(
    payload: Mapping[str, Any],
) -> dict[str, Any] | None:
    if _hook_name(payload) != "PreToolUse":
        return None
    tool_input = _tool_input_from(payload)
    raw_tool_name = _tool_name_from(payload)
    tool_name = _canonical_tool_name(raw_tool_name or "agy_tool", tool_input)
    if tool_name != "run_command":
        return None
    if not _should_shim_run_command():
        return None

    command = _run_command_value(tool_input)
    cwd = _safe_command_cwd(tool_input)
    timeout = max(
        1,
        _env_int(
            "CLI_AGENT_AGY_RUN_COMMAND_TIMEOUT_SECONDS",
            RUN_COMMAND_SHIM_DEFAULT_TIMEOUT_SECONDS,
        ),
    )
    if not command:
        result: dict[str, Any] = {
            "exit_code": 2,
            "timed_out": False,
            "duration_ms": 0,
            "stdout": "",
            "stderr": "AGY run_command payload did not include CommandLine.",
        }
    elif cwd is None:
        result = {
            "exit_code": 2,
            "timed_out": False,
            "duration_ms": 0,
            "stdout": "",
            "stderr": "AGY run_command cwd is outside the managed sandbox.",
        }
    else:
        try:
            result = _run_bash_command(command, cwd, timeout)
        except Exception as exc:  # noqa: BLE001
            result = {
                "exit_code": 126,
                "timed_out": False,
                "duration_ms": 0,
                "stdout": "",
                "stderr": f"Workflow-builder failed to execute command: {exc}",
            }

    stdout = str(result.get("stdout") or "")
    stderr = str(result.get("stderr") or "")
    output = stdout if stdout else stderr
    if stdout and stderr:
        output = f"{stdout}\n{stderr}"
    response = {
        "decision": "deny",
        "reason": _format_run_command_reason(result),
        "_workflowBuilderEvents": [
            _run_command_shim_event(tool_input, result, output),
            {
                "type": "hook.decision",
                "data": {
                    "hook_event": "PreToolUse",
                    "decision": "deny",
                    "reason": "agy-run-command-hook",
                    "tool_name": "run_command",
                },
            },
        ],
    }
    return response


def _entry_identity(entry: Mapping[str, Any]) -> str | None:
    parts: list[str] = []
    for key in ("conversation_id", "conversationId", "session_id", "sessionId"):
        value = clean_string(entry.get(key))
        if value:
            parts.append(value)
            break
    for key in (
        "uuid",
        "id",
        "event_id",
        "eventId",
        "step_id",
        "stepId",
        "step_index",
        "stepIndex",
        "index",
        "timestamp",
        "created_at",
    ):
        value = entry.get(key)
        if value is not None:
            text = str(value).strip()
            if text:
                parts.append(text)
                break
    return ":".join(parts) if parts else None


def _is_agy_assistant_entry(entry: Mapping[str, Any]) -> bool:
    role = clean_string(entry.get("role"))
    if role and role.lower() == "assistant":
        return True
    source = clean_string(entry.get("source"))
    if source and source.upper() in {"MODEL", "ASSISTANT", "AGENT"}:
        return True
    entry_type = clean_string(entry.get("type"))
    if entry_type and entry_type.upper() in {
        "ASSISTANT_MESSAGE",
        "MODEL_RESPONSE",
        "PLANNER_RESPONSE",
    }:
        return True
    return False


def _has_tool_calls(entry: Mapping[str, Any]) -> bool:
    for key in ("tool_calls", "toolCalls", "function_calls", "functionCalls"):
        value = entry.get(key)
        if isinstance(value, list) and value:
            return True
        if isinstance(value, Mapping) and value:
            return True
    return False


def _is_managed_run_command_denial_text(text: str) -> bool:
    # AGY records the denial reason from our PreToolUse shim as an assistant
    # transcript row. It is internal tool plumbing, not a user-visible final
    # answer, and treating it as final output produces duplicate turn.completed
    # events.
    return (
        "invalid tool call" in text
        and "Tool call denied with reason" in text
        and "Workflow-builder executed this run_command in the managed sandbox" in text
        and "agy-run-command-hook" not in text
    )


def _is_agy_tool_display_text(text: str) -> bool:
    normalized = text.strip()
    if not normalized.startswith("Created At:"):
        return False
    if "\nCompleted At:" not in normalized:
        return False
    # AGY stores native tool display panes as assistant transcript rows. They
    # all use this timestamp header, but their body shape varies by tool
    # (grep_search can be plain JSONL, read_file has a file path, large outputs
    # point at a saved file). None of these rows are a final assistant answer.
    return True


def _agy_final_response_text(entry: Mapping[str, Any]) -> str | None:
    if not _is_agy_assistant_entry(entry) or _has_tool_calls(entry):
        return None
    status = clean_string(entry.get("status") or entry.get("state"))
    if status and status.upper() not in {"DONE", "COMPLETE", "COMPLETED", "SUCCESS"}:
        return None
    for key in ("content", "response", "message", "text", "finalResponse"):
        text = _text_from_payload(entry.get(key))
        if text:
            if _is_managed_run_command_denial_text(text) or _is_agy_tool_display_text(text):
                return None
            return text
    return None


def _agy_user_input_text(entry: Mapping[str, Any]) -> str | None:
    source = clean_string(entry.get("source"))
    entry_type = clean_string(entry.get("type"))
    role = clean_string(entry.get("role"))
    if role and role.lower() == "user":
        pass
    elif source and source.upper() == "USER_EXPLICIT":
        pass
    elif entry_type and entry_type.upper() in {"USER_INPUT", "USER_MESSAGE"}:
        pass
    else:
        return None
    return _text_from_payload(entry.get("content") or entry.get("message") or entry.get("text"))


def _estimate_tokens(text: str | None) -> int:
    if not text:
        return 0
    stripped = text.strip()
    if not stripped:
        return 0
    # Conservative cross-model estimate: roughly four chars/token, never less
    # than the whitespace-token count. Used only when AGY omits native usage.
    return max(1, max(len(stripped) // 4, len(stripped.split())))


def _int_or_none(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _first_int(mapping: Mapping[str, Any], keys: tuple[str, ...]) -> int | None:
    for key in keys:
        value = _int_or_none(mapping.get(key))
        if value is not None:
            return value
    return None


def _agy_usage_record(entry: Mapping[str, Any]) -> Mapping[str, Any] | None:
    for key in ("usage", "tokenUsage", "usageMetadata", "tokens"):
        value = entry.get(key)
        if isinstance(value, Mapping):
            return value
    for parent_key in ("metadata", "message", "response"):
        parent = entry.get(parent_key)
        if not isinstance(parent, Mapping):
            continue
        for key in ("usage", "tokenUsage", "usageMetadata", "tokens"):
            value = parent.get(key)
            if isinstance(value, Mapping):
                return value
    return None


def _agy_usage(entry: Mapping[str, Any]) -> dict[str, Any] | None:
    usage = _agy_usage_record(entry)
    if usage is None:
        return None
    gross_input = _first_int(
        usage,
        (
            "input_tokens",
            "prompt_tokens",
            "promptTokenCount",
            "input",
            "prompt",
        ),
    )
    output_tokens = _first_int(
        usage,
        (
            "output_tokens",
            "completion_tokens",
            "candidatesTokenCount",
            "output",
            "completion",
            "candidates",
        ),
    )
    cache_read = _first_int(
        usage,
        (
            "cache_read_input_tokens",
            "cached_input_tokens",
            "cachedContentTokenCount",
            "cached_tokens",
            "cached",
        ),
    )
    cache_creation = _first_int(
        usage,
        (
            "cache_creation_input_tokens",
            "cache_write_input_tokens",
            "cacheCreationInputTokens",
            "cacheWriteInputTokens",
        ),
    )
    reasoning = _first_int(
        usage,
        ("reasoning_output_tokens", "thoughtsTokenCount", "thoughts"),
    )
    total = _first_int(usage, ("total_tokens", "totalTokenCount", "total"))
    if not any(
        value is not None
        for value in (gross_input, output_tokens, cache_read, cache_creation, reasoning, total)
    ):
        return None

    data: dict[str, Any] = {}
    if gross_input is not None:
        data["input_tokens"] = (
            max(0, gross_input - cache_read)
            if cache_read is not None
            else gross_input
        )
    if output_tokens is not None:
        data["output_tokens"] = output_tokens
    data["cache_read_input_tokens"] = cache_read or 0
    data["cache_creation_input_tokens"] = cache_creation or 0
    if reasoning is not None:
        data["reasoning_output_tokens"] = reasoning
    if total is not None:
        data["total_tokens"] = total
    model = clean_string(entry.get("model") or entry.get("model_name") or entry.get("modelName"))
    if model:
        data["model"] = model
    return data


class AntigravityAdapter(CliAdapter):
    name = "antigravity"
    # agy mirrors events from herdr/native state (no UserPromptSubmit hook), so
    # the Claude-only INJECTION_MARKER has no dedup function here — don't send it.
    uses_injection_marker = False
    # herdr only SCREEN-DETECTS agy (no native state) and reports `idle` during the
    # pre-composer boot screen, so the kickoff must wait until agy's composer is
    # actually rendered — gate on its idle-prompt footer.
    prompt_ready_marker = "? for shortcuts"
    # AGY can answer a short prompt and return to its idle composer before the
    # supervisor's post-Enter verification sample. Treat that idle sample as a
    # successful submit rather than repeatedly pressing Enter into the composer.
    idle_after_submit_is_success = True
    prompt_not_ready_markers = (
        "executor has not processed the previous input yet",
    )
    # herdr SCREEN-DETECTS agy and reports `idle` during the boot banner + the
    # "model no longer available" warning, before the composer takes focus.
    # Accepting that idle injected the kickoff too early and the Enter was
    # dropped (prompt stranded in the composer, zero hooks). Wait for the real
    # rendered composer marker instead.
    trust_idle_ready_fallback = False
    # agy's composer collapses a held multi-line draft to "↑ N more lines"; if
    # that's on screen after Enter, the submit was dropped → re-press.
    composer_draft_markers = ("more lines",)

    def __init__(self) -> None:
        self._last_user_input_text: str | None = None

    def format_seed_user_message(self, text: str) -> str:
        return text.strip()

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
        self._last_user_input_text = None
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
        servers = _agy_mcp_servers(agent_config, result.warnings)
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
        guard_path = write_stop_guard_config(session_input)
        if guard_path:
            result.paths["agyStopGuardPath"] = guard_path

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

        # (c) settings.json — merge our managed unattended keys into the
        # restored profile every run. The login bundle may carry a local
        # request-review permission mode; keeping that value blocks workflow
        # sessions on invisible approval prompts.
        settings_path = cli_dir / "settings.json"
        settings = _managed_agy_settings(_read_settings(settings_path), agent_config)
        settings_path.write_text(
            json.dumps(settings, indent=2) + "\n", encoding="utf-8"
        )
        result.paths["agySettingsPath"] = str(settings_path)

        return result

    # -- argv -----------------------------------------------------------------

    def build_argv(
        self, agent_config: Mapping[str, Any], seed_paths: Mapping[str, str]
    ) -> list[str]:
        sandbox_root = os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")
        argv: list[str] = [
            AGY_BIN,
            "--dangerously-skip-permissions",
            "--sandbox=false",
            "--add-dir",
            sandbox_root,
        ]
        model = normalize_agy_model(agent_config.get("modelSpec"))
        if model:
            argv += ["--model", model]
        return argv

    def extract_completion_text(self, payload: Mapping[str, Any]) -> str | None:
        return _text_from_payload(payload)

    def hook_response(
        self, event_name: str, payload: Mapping[str, Any], session: Mapping[str, Any]
    ) -> dict[str, Any] | None:
        if event_name == "PreToolUse":
            return _execute_run_command_shim(payload)
        if event_name == "Stop":
            return evaluate_stop_guard(increment_continue=True)
        return None

    def map_hook_event(self, payload: Mapping[str, Any]) -> list[dict[str, Any]] | None:
        name = _hook_name(payload)
        if name == "PreToolUse":
            tool_input = _tool_input_from(payload)
            raw_tool_name = _tool_name_from(payload)
            if not raw_tool_name and not tool_input:
                return []
            raw_tool_name = raw_tool_name or "agy_tool"
            tool_name = _canonical_tool_name(raw_tool_name, tool_input)
            data: dict[str, Any] = {
                "tool_name": tool_name,
                "name": tool_name,
                "tool_input": tool_input,
                "input": tool_input,
                **_mcp_tool_metadata(tool_name),
            }
            if tool_name != raw_tool_name:
                data["raw_tool_name"] = raw_tool_name
            return [
                {
                    "type": "agent.tool_use",
                    "data": data,
                }
            ]
        if name in ("PostToolUse", "PostToolUseFailure"):
            tool_input = _tool_input_from(payload)
            output = _tool_output_from(payload)
            raw_tool_name = _tool_name_from(payload)
            if (
                not raw_tool_name
                and not tool_input
                and not output
                and name == "PostToolUse"
            ):
                return []
            raw_tool_name = raw_tool_name or "agy_tool"
            tool_name = _canonical_tool_name(raw_tool_name, tool_input)
            if tool_name == "run_command" and _should_shim_run_command():
                return []
            ok = name == "PostToolUse"
            data: dict[str, Any] = {
                "tool_name": tool_name,
                "name": tool_name,
                "ok": ok,
                "success": ok,
                "output": output,
                "output_preview": output[:500] if output else "",
                **_mcp_tool_metadata(tool_name),
            }
            if tool_input:
                data["tool_input"] = tool_input
                data["input"] = tool_input
            if tool_name != raw_tool_name:
                data["raw_tool_name"] = raw_tool_name
            if not ok:
                data["is_error"] = True
                data["error"] = clean_string(payload.get("error")) or "tool failed"
            return [{"type": "agent.tool_result", "data": data}]
        return None

    def discover_transcript_path(self) -> str | None:
        """Antigravity writes its transcript to
        ``~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl``
        with a runtime-generated conversation id, and its command hooks don't
        reliably carry ``transcript_path``. Glob for the newest one so the hooks
        receiver can register the tailer from any hook (it backfills from offset 0,
        so a late register is lossless). Prevents the transient 'no agent.message/
        llm_usage mirrored' miss seen on fresh agy sessions."""
        import glob
        import os

        pattern = os.path.join(
            os.path.expanduser("~"),
            ".gemini",
            "antigravity-cli",
            "brain",
            "*",
            ".system_generated",
            "logs",
            "transcript_full.jsonl",
        )
        try:
            matches = glob.glob(pattern)
            if not matches:
                return None
            return max(matches, key=os.path.getmtime)
        except OSError:
            return None

    def map_transcript_entry(
        self, entry: Mapping[str, Any]
    ) -> list[dict[str, Any]] | None:
        events: list[dict[str, Any]] = []
        user_text = _agy_user_input_text(entry)
        if user_text:
            self._last_user_input_text = user_text
        identity = _entry_identity(entry)
        text = _agy_final_response_text(entry)
        usage = _agy_usage(entry)
        if text:
            data: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
            model = clean_string(
                entry.get("model") or entry.get("model_name") or entry.get("modelName")
            )
            if model:
                data["model"] = model
            event: dict[str, Any] = {"type": "agent.message", "data": data}
            if identity:
                event["sourceEventId"] = f"agy-transcript:{identity}:message"
            events.append(event)
        if usage is None and text:
            usage = {
                "input_tokens": _estimate_tokens(self._last_user_input_text),
                "output_tokens": _estimate_tokens(text),
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
                "context_source": "transcript_estimate",
                "context_count_method": "estimated",
                "context_count_scope": "last_agy_turn",
                "usage_estimated": True,
                "usage_source": "agy_transcript_estimate",
            }
            model = clean_string(
                entry.get("model") or entry.get("model_name") or entry.get("modelName")
            )
            if model:
                usage["model"] = model
        if usage:
            event = {"type": "agent.llm_usage", "data": usage}
            if identity:
                event["sourceEventId"] = f"agy-transcript:{identity}:usage"
            events.append(event)
        return events

    # Turn completion is owned EXCLUSIVELY by the Stop hook (base defaults). For
    # these single-turn autoTerminate build runs AGY fires Stop after its tool use;
    # the transcript is read only for CONTENT (map_transcript_entry). The
    # output-sync stop-guard (has_stop_guard_config) still gates the Stop hook's
    # completion via hook_response, not via the transcript.

    # -- env -------------------------------------------------------------------

    def pane_env(
        self,
        base_env: Mapping[str, str],
        *,
        session_id: str | None = None,
    ) -> dict[str, str]:
        env: dict[str, str] = {}
        passthrough = (
            "PATH",
            "TERM",
            "GITHUB_TOKEN",  # git clone/push + PR for coding workflows (NOT the LLM key)
            "PLAYWRIGHT_BROWSERS_PATH",  # /opt/pw-browsers — the critic's Playwright chromium
        )
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
