"""Bash tool -- shell command execution with destructive command warnings.

Originally ported from claude-code-src/main/tools/BashTool/BashTool.tsx; the
model-facing schema and description are now aligned to Moonshot's kimi-code v2
Bash tool (packages/agent-core-v2/src/os/backends/node-local/tools/bash.ts),
adapted for our journaled Dapr runtime: no background execution and no cwd
parameter. The `timeout` wire value is seconds (default 60, max 300).
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from src.openshell_runtime import get_runtime
from .._security import get_destructive_warning
from .prompt import (
    get_bash_tool_description,
    _DEFAULT_TIMEOUT_SECONDS,
    _MAX_TIMEOUT_SECONDS,
)


class BashArgs(BaseModel):
    """Wire schema for the Bash tool (kimi-code v2 aligned)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    command: str = Field(description="The command to execute.")
    timeout: int = Field(
        default=_DEFAULT_TIMEOUT_SECONDS,
        description=f"Timeout in seconds (max {_MAX_TIMEOUT_SECONDS}).",
    )
    description: str | None = Field(
        default=None,
        description="Short description of what the command does.",
    )


def bash_run(
    command: str,
    timeout: int | None = None,
    description: str | None = None,
) -> str:
    if not command or not command.strip():
        return "Error: No command provided."

    # kimi-code v2 wire semantics: timeout is already in seconds.
    timeout_sec = min(timeout or _DEFAULT_TIMEOUT_SECONDS, _MAX_TIMEOUT_SECONDS)

    # Check for destructive patterns (warn but don't block)
    warning = get_destructive_warning(command)

    try:
        result = get_runtime().execute(
            command,
            timeout_seconds=int(timeout_sec),
        )
    except TimeoutError:
        return (
            f"Error: Command timed out after {timeout_sec} seconds.\n"
            f"Command: {command}"
        )
    except Exception as exc:
        return f"Error executing command: {exc}"

    # Build output
    parts: list[str] = []

    if warning:
        parts.append(f"Warning: {warning}")

    stdout = str(result.get("stdout") or "")
    stderr = str(result.get("stderr") or "")
    exit_code = int(result.get("exit_code") or 0)

    if stdout.strip():
        parts.append(stdout.strip())

    if stderr.strip():
        parts.append(f"stderr:\n{stderr.strip()}")

    if exit_code != 0:
        parts.append(f"Exit code: {exit_code}")

    return "\n".join(parts) if parts else "(no output)"


bash_run.__doc__ = get_bash_tool_description()
