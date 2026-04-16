"""Command hook executor.

Ported from the command-hook execution path in
claude-code-src/main/utils/hooks.ts (executeHooks, lines ~2200-2400).

Runs a shell command with JSON on stdin, parses stdout as JSON.
Exit codes: 0 = success, 2 = blocking error, other = non-blocking error.
"""

from __future__ import annotations

import logging
import os
import subprocess
import threading
from typing import Any

from ..helpers import (
    hook_result_from_output,
    parse_hook_json_output,
)
from ..types import (
    CommandHookConfig,
    HookOutcome,
    HookResult,
)

logger = logging.getLogger(__name__)

# Default timeout for command hooks (seconds)
DEFAULT_COMMAND_TIMEOUT = 600


def exec_command_hook(
    hook: CommandHookConfig,
    input_json: str,
    *,
    env_overrides: dict[str, str] | None = None,
    timeout: int | None = None,
) -> HookResult:
    """Execute a command hook synchronously.

    The command receives JSON on stdin and should return JSON on stdout.
    """
    effective_timeout = timeout or hook.timeout or DEFAULT_COMMAND_TIMEOUT
    command = hook.command

    if not command:
        return HookResult(outcome=HookOutcome.NON_BLOCKING_ERROR)

    # Build environment
    env = os.environ.copy()
    if env_overrides:
        env.update(env_overrides)

    try:
        proc = subprocess.run(
            command,
            input=input_json.encode("utf-8"),
            capture_output=True,
            timeout=effective_timeout,
            shell=True,
            env=env,
        )
    except subprocess.TimeoutExpired:
        logger.warning("Command hook timed out after %ds: %s", effective_timeout, command[:80])
        return HookResult(outcome=HookOutcome.NON_BLOCKING_ERROR)
    except OSError as exc:
        logger.warning("Command hook failed to execute: %s — %s", command[:80], exc)
        return HookResult(outcome=HookOutcome.NON_BLOCKING_ERROR)

    stdout = proc.stdout.decode("utf-8", errors="replace") if proc.stdout else ""
    stderr = proc.stderr.decode("utf-8", errors="replace") if proc.stderr else ""

    if stderr:
        logger.debug("Command hook stderr: %s", stderr[:500])

    output = parse_hook_json_output(stdout)
    return hook_result_from_output(output, command_desc=command, exit_code=proc.returncode)


def exec_command_hook_async(
    hook: CommandHookConfig,
    input_json: str,
    *,
    env_overrides: dict[str, str] | None = None,
) -> None:
    """Execute a command hook in a background daemon thread.

    Fire-and-forget — mirrors the async hook pattern in event_publisher.py.
    """
    def _run() -> None:
        try:
            exec_command_hook(hook, input_json, env_overrides=env_overrides)
        except Exception:
            logger.debug("Async command hook failed: %s", hook.command[:80], exc_info=True)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
