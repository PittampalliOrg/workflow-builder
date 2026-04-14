"""OpenShell sandbox tools for dapr-agent-py.

These tools communicate with the openshell-agent-runtime HTTP API to execute
commands and manage files inside sandboxed workspaces.  Multi-line content is
base64-encoded to avoid gRPC newline validation issues in the Dapr workflow
activity transport.
"""

from __future__ import annotations

import base64
import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx
from dapr_agents.tool import tool

logger = logging.getLogger(__name__)

OPENSHELL_RUNTIME_URL = os.environ.get(
    "OPENSHELL_RUNTIME_URL",
    "http://openshell-agent-runtime.openshell.svc.cluster.local:8083",
)
OPENSHELL_COMMAND_TIMEOUT_MS = int(
    os.environ.get("OPENSHELL_COMMAND_TIMEOUT_MS", "600000")
)


@dataclass
class ExecuteResult:
    output: str
    exit_code: int


class OpenShellSandbox:
    """Lightweight OpenShell sandbox client."""

    def __init__(
        self,
        workspace_ref: str,
        cwd: str = "/sandbox",
        base_url: str | None = None,
    ) -> None:
        self.workspace_ref = workspace_ref
        self.cwd = cwd
        self.base_url = base_url or OPENSHELL_RUNTIME_URL

    def execute(self, command: str, timeout: int = 300) -> ExecuteResult:
        timeout_ms = timeout * 1000
        payload = {
            "workspaceRef": self.workspace_ref,
            "command": command,
            "cwd": self.cwd,
            "timeoutMs": timeout_ms,
        }
        with httpx.Client(timeout=max(timeout_ms / 1000 + 30, 60)) as client:
            resp = client.post(
                f"{self.base_url}/api/workspaces/command", json=payload
            )
            resp.raise_for_status()
            data = resp.json()

        stdout = data.get("stdout") or ""
        stderr = data.get("stderr") or ""
        output = stdout
        if stderr:
            output = f"{output}\nstderr:\n{stderr}" if output else f"stderr:\n{stderr}"
        return ExecuteResult(
            output=output, exit_code=data.get("exitCode", 1)
        )


# ---------------------------------------------------------------------------
# Global mutable sandbox reference — bound at workflow start
# ---------------------------------------------------------------------------

_sandbox: OpenShellSandbox | None = None


def bind_sandbox(workspace_ref: str, cwd: str = "/sandbox") -> None:
    """Bind the global sandbox to a specific workspace for the current run."""
    global _sandbox
    _sandbox = OpenShellSandbox(workspace_ref=workspace_ref, cwd=cwd)
    logger.info("Sandbox bound: ref=%s cwd=%s", workspace_ref, cwd)


def get_sandbox() -> OpenShellSandbox:
    if _sandbox is None:
        raise RuntimeError(
            "Sandbox not bound. Call bind_sandbox() before using tools."
        )
    return _sandbox


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------


@tool
def execute_command(command: str, timeout: int = 300) -> str:
    """Run a shell command in the sandbox and return its output.

    Args:
        command: The shell command to execute.
        timeout: Maximum seconds to wait (default 300).

    Returns:
        Command output (stdout + stderr).
    """
    try:
        result = get_sandbox().execute(command, timeout=timeout)
        output = result.output or ""
        if result.exit_code != 0:
            output += f"\n[exit code {result.exit_code}]"
        return output
    except Exception as exc:
        return f"Error executing command: {exc}"


@tool
def read_file(path: str) -> str:
    """Read a file from the sandbox and return its contents.

    Args:
        path: Absolute or relative path of the file to read.

    Returns:
        The file contents, or an error message.
    """
    try:
        result = get_sandbox().execute(f"cat '{path}'", timeout=30)
        if result.exit_code != 0:
            return f"Error reading {path}: {result.output}"
        return result.output
    except Exception as exc:
        return f"Error reading {path}: {exc}"


@tool
def write_file(path: str, content: str) -> str:
    """Write content to a file in the sandbox, creating parent directories.

    Args:
        path: Absolute or relative path of the file to write.
        content: The full file content to write.

    Returns:
        Success or error message.
    """
    try:
        encoded = base64.b64encode(content.encode("utf-8")).decode("ascii")
        cmd = (
            f"mkdir -p \"$(dirname '{path}')\" && "
            f"printf '%s' '{encoded}' | base64 -d > '{path}'"
        )
        result = get_sandbox().execute(cmd, timeout=30)
        if result.exit_code != 0:
            return f"Error writing {path}: {result.output}"
        return f"Successfully wrote {path}"
    except Exception as exc:
        return f"Error writing {path}: {exc}"


@tool
def list_files(path: str = ".") -> str:
    """List files and directories in the sandbox.

    Args:
        path: Directory path to list (default: current directory).

    Returns:
        Detailed file listing.
    """
    try:
        result = get_sandbox().execute(f"ls -la '{path}'", timeout=30)
        if result.exit_code != 0:
            return f"Error listing {path}: {result.output}"
        return result.output
    except Exception as exc:
        return f"Error listing {path}: {exc}"


@tool
def search_files(pattern: str, path: str = ".", file_glob: str = "") -> str:
    """Search for a regex pattern in files using grep.

    Args:
        pattern: Regex pattern to search for.
        path: Directory to search in (default: current directory).
        file_glob: Optional glob to filter files (e.g. '*.svelte').

    Returns:
        Matching lines with file paths and line numbers.
    """
    try:
        glob_flag = f"--include='{file_glob}'" if file_glob else ""
        cmd = f"grep -rn {glob_flag} '{pattern}' '{path}' | head -200"
        result = get_sandbox().execute(cmd, timeout=60)
        if result.exit_code == 1:
            return "No matches found."
        if result.exit_code != 0:
            return f"Error searching: {result.output}"
        return result.output or "No matches found."
    except Exception as exc:
        return f"Error searching: {exc}"


ALL_TOOLS = [execute_command, read_file, write_file, list_files, search_files]
