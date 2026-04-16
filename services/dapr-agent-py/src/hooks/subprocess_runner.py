"""Async subprocess runner for `command`-type hooks.

Contract (mirrors TS utils/hooks.ts:747-1050):
    stdin:   HookInput JSON + "\n"
    stdout:  HookJSONOutput JSON (or plain text = success with no output)
    exit 0:  success
    exit 2:  blocking error (stderr => blocking_reason)
    other:   non-blocking error (advisory)

Env injected: CLAUDE_PROJECT_DIR, CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA,
CLAUDE_PLUGIN_OPTION_<KEY>. Command string substitutes ${CLAUDE_PLUGIN_ROOT},
${CLAUDE_PLUGIN_DATA}, and ${user_config.X}.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
from dataclasses import dataclass
from typing import Any, Optional

from .schemas import BashCommandHook, HookResult, SyncHookJSONOutput

logger = logging.getLogger(__name__)


# TS defaults (hooks.ts:166-182)
DEFAULT_HOOK_TIMEOUT_MS = 600_000  # 10 min
SESSION_END_TIMEOUT_MS = 1_500
# Activity-safe cap to avoid blocking Dapr RPC deadlines.
MAX_COMMAND_HOOK_TIMEOUT_MS = 300_000  # 5 min


@dataclass
class RunnerContext:
    project_dir: str
    plugin_root: Optional[str] = None
    plugin_data: Optional[str] = None
    plugin_options: dict[str, str] | None = None
    default_timeout_ms: int = DEFAULT_HOOK_TIMEOUT_MS
    env_extra: dict[str, str] | None = None


def _substitute(command: str, ctx: RunnerContext) -> str:
    substitutions = {
        "${CLAUDE_PROJECT_DIR}": ctx.project_dir,
        "${CLAUDE_PLUGIN_ROOT}": ctx.plugin_root or "",
        "${CLAUDE_PLUGIN_DATA}": ctx.plugin_data or "",
    }
    for k, v in substitutions.items():
        command = command.replace(k, v)
    for key, value in (ctx.plugin_options or {}).items():
        command = command.replace("${user_config." + key + "}", str(value))
    return command


def _build_env(ctx: RunnerContext) -> dict[str, str]:
    env = dict(os.environ)
    env["CLAUDE_PROJECT_DIR"] = ctx.project_dir
    if ctx.plugin_root:
        env["CLAUDE_PLUGIN_ROOT"] = ctx.plugin_root
    if ctx.plugin_data:
        env["CLAUDE_PLUGIN_DATA"] = ctx.plugin_data
    for key, value in (ctx.plugin_options or {}).items():
        sanitized = "".join(c for c in key.upper() if c.isalnum() or c == "_")
        if sanitized:
            env[f"CLAUDE_PLUGIN_OPTION_{sanitized}"] = str(value)
    for key, value in (ctx.env_extra or {}).items():
        env[str(key)] = str(value)
    return env


def _timeout_ms(hook: BashCommandHook, default: int) -> int:
    if hook.timeout is not None and hook.timeout > 0:
        ms = int(hook.timeout * 1000)
    else:
        ms = default
    return max(1000, min(ms, MAX_COMMAND_HOOK_TIMEOUT_MS))


def _parse_output(stdout_bytes: bytes) -> SyncHookJSONOutput | None:
    text = stdout_bytes.decode("utf-8", errors="replace").strip()
    if not text:
        return None
    if not text.startswith("{"):
        # Plain-text output from a hook = success + no decision.
        return None
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        logger.warning("[hooks] Invalid hook JSON output: %s; raw=%.200r", exc, text)
        return None
    if not isinstance(payload, dict):
        return None
    try:
        return SyncHookJSONOutput.model_validate(payload)
    except Exception as exc:
        logger.warning("[hooks] Hook JSON failed schema: %s; raw=%.200r", exc, text)
        return None


def _pick_shell(hook: BashCommandHook) -> tuple[str, list[str]] | None:
    shell = hook.shell or "bash"
    if shell == "powershell":
        pwsh = shutil.which("pwsh") or shutil.which("powershell")
        if not pwsh:
            return None
        return pwsh, ["-NoProfile", "-NonInteractive", "-Command"]
    # bash: use /bin/bash if available, else /bin/sh
    bash = shutil.which("bash") or "/bin/sh"
    return bash, ["-c"]


async def run_command_hook(
    hook: BashCommandHook,
    hook_input: dict[str, Any],
    ctx: RunnerContext,
    plugin_id: Optional[str] = None,
    matcher: Optional[str] = None,
) -> HookResult:
    """Execute a single command hook. Always returns a HookResult — never raises."""
    started = time.monotonic()
    command = _substitute(hook.command, ctx)
    shell_spec = _pick_shell(hook)
    if shell_spec is None:
        return HookResult(
            outcome="non_blocking_error",
            hook_type="command",
            plugin_id=plugin_id,
            matcher=matcher,
            duration_ms=0,
            reason="powershell requested but not available on PATH",
        )
    shell_path, shell_args = shell_spec
    timeout_ms = _timeout_ms(hook, ctx.default_timeout_ms)
    env = _build_env(ctx)
    input_bytes = (json.dumps(hook_input) + "\n").encode("utf-8")

    effective_cwd: Optional[str] = None
    if ctx.project_dir and os.path.isdir(ctx.project_dir):
        effective_cwd = ctx.project_dir
    try:
        proc = await asyncio.create_subprocess_exec(
            shell_path,
            *shell_args,
            command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=effective_cwd,
        )
    except (OSError, ValueError) as exc:
        return HookResult(
            outcome="non_blocking_error",
            hook_type="command",
            plugin_id=plugin_id,
            matcher=matcher,
            duration_ms=int((time.monotonic() - started) * 1000),
            reason=f"failed to spawn: {exc}",
        )

    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(input=input_bytes),
            timeout=timeout_ms / 1000.0,
        )
    except asyncio.TimeoutError:
        proc.kill()
        try:
            await proc.wait()
        except Exception:
            pass
        return HookResult(
            outcome="blocking",
            hook_type="command",
            plugin_id=plugin_id,
            matcher=matcher,
            duration_ms=timeout_ms,
            reason=f"hook timed out after {timeout_ms} ms",
        )

    duration_ms = int((time.monotonic() - started) * 1000)
    exit_code = proc.returncode if proc.returncode is not None else -1
    stderr_tail = stderr_bytes.decode("utf-8", errors="replace")[-4000:]
    output = _parse_output(stdout_bytes)

    if exit_code == 0:
        return HookResult(
            outcome="ok",
            hook_type="command",
            plugin_id=plugin_id,
            matcher=matcher,
            duration_ms=duration_ms,
            exit_code=exit_code,
            output=output,
        )
    if exit_code == 2:
        reason = stderr_tail.strip() or (output.reason if output and output.reason else "hook blocked")
        return HookResult(
            outcome="blocking",
            hook_type="command",
            plugin_id=plugin_id,
            matcher=matcher,
            duration_ms=duration_ms,
            exit_code=exit_code,
            reason=reason,
            stderr_tail=stderr_tail or None,
            output=output,
        )
    return HookResult(
        outcome="non_blocking_error",
        hook_type="command",
        plugin_id=plugin_id,
        matcher=matcher,
        duration_ms=duration_ms,
        exit_code=exit_code,
        reason=(output.reason if output and output.reason else stderr_tail.strip() or None),
        stderr_tail=stderr_tail or None,
        output=output,
    )


__all__ = [
    "RunnerContext",
    "run_command_hook",
    "DEFAULT_HOOK_TIMEOUT_MS",
    "SESSION_END_TIMEOUT_MS",
    "MAX_COMMAND_HOOK_TIMEOUT_MS",
]
