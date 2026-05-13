"""BashRun tool -- shell command execution with destructive command warnings.

Ported from claude-code-src/main/tools/BashTool/BashTool.tsx
"""

from __future__ import annotations

from src.openshell_runtime import get_runtime
from src.swebench_bash_policy import swebench_bash_policy_violation
from .._security import get_destructive_warning
from .prompt import get_bash_tool_description, _DEFAULT_TIMEOUT_MS, _MAX_TIMEOUT_MS


def bash_run(
    command: str,
    timeout: int | None = None,
    description: str | None = None,
) -> str:
    if not command or not command.strip():
        return "Error: No command provided."

    runtime = get_runtime()
    policy_error = swebench_bash_policy_violation(command, runtime.session_id)
    if policy_error:
        return policy_error

    # Convert timeout from ms to seconds
    timeout_ms = min(timeout or _DEFAULT_TIMEOUT_MS, _MAX_TIMEOUT_MS)
    timeout_sec = timeout_ms / 1000

    # Check for destructive patterns (warn but don't block)
    warning = get_destructive_warning(command)

    try:
        result = runtime.execute(
            command,
            timeout_seconds=int(timeout_sec),
        )
    except TimeoutError:
        return (
            f"Error: Command timed out after {timeout_sec:.0f} seconds.\n"
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
