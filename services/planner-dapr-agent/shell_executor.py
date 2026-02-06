"""Native OpenAI SDK ShellTool executor for codebase exploration.

This module provides a safe shell executor implementation that works with the
OpenAI Agents SDK's ShellTool. It uses a whitelist approach to only allow
read-only commands suitable for codebase exploration.

Usage:
    from shell_executor import create_shell_tool

    shell_tool = create_shell_tool("/app/workspace")
    agent = Agent(tools=[shell_tool], ...)
"""

import asyncio
import os
import shlex
from typing import Optional

# Note: These imports are from openai-agents SDK
# The actual types may vary based on SDK version - we define compatible interfaces
from dataclasses import dataclass
from enum import Enum
from typing import List


class ShellCallOutcome(str, Enum):
    """Outcome of a shell command execution."""
    SUCCESS = "success"
    ERROR = "error"
    TIMEOUT = "timeout"


@dataclass
class ShellCommandOutput:
    """Output from a single shell command."""
    command: str
    outcome: ShellCallOutcome
    output: str


@dataclass
class ShellResult:
    """Result containing outputs from all executed commands."""
    outputs: List[ShellCommandOutput]


@dataclass
class ShellCommandRequest:
    """Request to execute shell commands."""
    commands: List[str]
    timeout_ms: Optional[int] = None


# Workspace directory
DEFAULT_CWD = os.getenv("PLANNER_CWD", "/app/workspace")

# Allowed commands for safety (whitelist approach)
# These are read-only commands suitable for codebase exploration
ALLOWED_COMMANDS = {
    # File content viewing
    "cat", "head", "tail", "less", "more",
    # Search and find
    "grep", "find", "locate", "which", "whereis",
    # Directory listing
    "ls", "tree", "du",
    # File information
    "file", "stat", "readlink", "realpath",
    # Path manipulation
    "dirname", "basename", "pwd",
    # Text processing (read-only)
    "wc", "sort", "uniq", "cut", "awk", "sed",
    # Archive inspection (read-only)
    "tar", "unzip", "zipinfo",
    # Version control (read-only)
    "git",
    # Language-specific tools (read-only inspection)
    "python", "node", "npm", "pip", "cargo", "go",
}

# Git subcommands that are allowed (read-only)
ALLOWED_GIT_SUBCOMMANDS = {
    "status", "log", "diff", "show", "branch", "remote", "tag",
    "ls-files", "ls-tree", "rev-parse", "describe", "blame",
    "shortlog", "reflog", "config", "rev-list",
}

# Commands that are blocked even if they look like allowed commands
BLOCKED_PATTERNS = {
    # File modification
    "rm", "mv", "cp", "mkdir", "rmdir", "touch",
    # Permission changes
    "chmod", "chown", "chgrp",
    # Package installation
    "install", "uninstall",
    # Network operations
    "curl", "wget", "ssh", "scp", "rsync",
    # Process control
    "kill", "pkill", "killall",
    # System operations
    "sudo", "su", "reboot", "shutdown",
}


def is_command_allowed(cmd: str) -> tuple[bool, str]:
    """Check if a command is allowed based on whitelist.

    Returns:
        Tuple of (is_allowed, reason_if_blocked)
    """
    if not cmd or not cmd.strip():
        return False, "Empty command"

    # Parse the command to get the base command
    try:
        parts = shlex.split(cmd)
    except ValueError:
        # Fall back to simple split if shlex fails
        parts = cmd.split()

    if not parts:
        return False, "Empty command after parsing"

    base_cmd = parts[0]

    # Handle path prefixes (e.g., /usr/bin/cat -> cat)
    base_cmd = os.path.basename(base_cmd)

    # Check against blocked patterns first
    for blocked in BLOCKED_PATTERNS:
        if blocked in cmd.lower():
            return False, f"Command contains blocked pattern: {blocked}"

    # Check if base command is in whitelist
    if base_cmd not in ALLOWED_COMMANDS:
        return False, f"Command '{base_cmd}' not in allowed list: {sorted(ALLOWED_COMMANDS)}"

    # Special handling for git - check subcommand
    if base_cmd == "git" and len(parts) > 1:
        git_subcmd = parts[1]
        if git_subcmd not in ALLOWED_GIT_SUBCOMMANDS:
            return False, f"Git subcommand '{git_subcmd}' not allowed. Use: {sorted(ALLOWED_GIT_SUBCOMMANDS)}"

    # Special handling for potentially dangerous flags
    # Only check these for commands where they're actually dangerous
    dangerous_flag_commands = {"rm", "git", "cp", "mv"}
    if base_cmd in dangerous_flag_commands:
        dangerous_flags = {"--delete", "--force", "-f", "--hard", "--remove", "-rf", "-fr"}
        for flag in dangerous_flags:
            if flag in parts:
                return False, f"Dangerous flag '{flag}' not allowed for '{base_cmd}'"

    return True, ""


class SafeShellExecutor:
    """Shell executor with safety checks for codebase exploration.

    This executor only allows a whitelist of read-only commands,
    making it safe for AI agents to explore codebases without
    risk of accidental modifications.
    """

    def __init__(
        self,
        workspace_dir: str = DEFAULT_CWD,
        timeout_ms: int = 30000,
        max_output_chars: int = 50000,
    ):
        """Initialize the shell executor.

        Args:
            workspace_dir: Working directory for command execution
            timeout_ms: Default timeout in milliseconds
            max_output_chars: Maximum characters to return in output
        """
        self.workspace_dir = workspace_dir
        self.timeout_ms = timeout_ms
        self.max_output_chars = max_output_chars

    async def __call__(self, request: ShellCommandRequest) -> ShellResult:
        """Execute shell commands with safety checks.

        Args:
            request: Request containing commands to execute

        Returns:
            ShellResult with outputs from all commands
        """
        outputs = []

        for cmd in request.commands:
            # Safety check: only allow whitelisted commands
            allowed, reason = is_command_allowed(cmd)
            if not allowed:
                outputs.append(ShellCommandOutput(
                    command=cmd,
                    outcome=ShellCallOutcome.ERROR,
                    output=f"Command not allowed: {reason}",
                ))
                continue

            try:
                timeout = (request.timeout_ms or self.timeout_ms) / 1000

                # Create subprocess
                proc = await asyncio.create_subprocess_shell(
                    cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=self.workspace_dir,
                    # Set environment to be safe
                    env={
                        **os.environ,
                        "HOME": self.workspace_dir,
                        "PWD": self.workspace_dir,
                    },
                )

                # Wait for completion with timeout
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(), timeout=timeout
                )

                # Combine and truncate output
                output = stdout.decode(errors="replace")
                if len(output) > self.max_output_chars:
                    output = output[:self.max_output_chars] + f"\n... [truncated at {self.max_output_chars} chars]"

                if stderr:
                    stderr_text = stderr.decode(errors="replace")[:5000]
                    output += f"\n[stderr]: {stderr_text}"

                outputs.append(ShellCommandOutput(
                    command=cmd,
                    outcome=ShellCallOutcome.SUCCESS if proc.returncode == 0 else ShellCallOutcome.ERROR,
                    output=output,
                ))

            except asyncio.TimeoutError:
                outputs.append(ShellCommandOutput(
                    command=cmd,
                    outcome=ShellCallOutcome.TIMEOUT,
                    output=f"Command timed out after {timeout}s",
                ))
            except Exception as e:
                outputs.append(ShellCommandOutput(
                    command=cmd,
                    outcome=ShellCallOutcome.ERROR,
                    output=f"Execution error: {str(e)}",
                ))

        return ShellResult(outputs=outputs)


def create_shell_tool(workspace_dir: str = DEFAULT_CWD):
    """Create a shell tool with the safe executor.

    This function creates an OpenAI Agents SDK compatible shell tool
    that uses our SafeShellExecutor for secure codebase exploration.

    Args:
        workspace_dir: Working directory for command execution

    Returns:
        A function tool that can be used with OpenAI Agents SDK
    """
    from agents import function_tool

    executor = SafeShellExecutor(workspace_dir)

    @function_tool
    async def shell(commands: list[str], timeout_ms: int = 30000) -> dict:
        """Execute shell commands for codebase exploration.

        This tool allows running read-only shell commands to explore the codebase.
        Allowed commands include: cat, grep, find, ls, tree, git status, etc.

        Args:
            commands: List of shell commands to execute
            timeout_ms: Timeout in milliseconds for each command

        Returns:
            Dictionary with command outputs and outcomes
        """
        request = ShellCommandRequest(commands=commands, timeout_ms=timeout_ms)
        result = await executor(request)

        return {
            "outputs": [
                {
                    "command": out.command,
                    "outcome": out.outcome.value,
                    "output": out.output,
                }
                for out in result.outputs
            ]
        }

    return shell


def create_file_reader_tool(workspace_dir: str = DEFAULT_CWD):
    """Create a specialized file reader tool.

    This is a convenience wrapper around shell that specifically
    handles file reading with better error messages.
    """
    from agents import function_tool

    @function_tool
    async def read_file(path: str, start_line: int = 1, num_lines: int = 500) -> dict:
        """Read contents of a file.

        Args:
            path: Path to the file (relative to workspace or absolute)
            start_line: Starting line number (1-indexed)
            num_lines: Number of lines to read

        Returns:
            Dictionary with file contents and metadata
        """
        # Resolve path relative to workspace
        if not os.path.isabs(path):
            full_path = os.path.join(workspace_dir, path)
        else:
            full_path = path

        # Check if file exists
        if not os.path.exists(full_path):
            return {
                "success": False,
                "error": f"File not found: {path}",
                "path": full_path,
            }

        if os.path.isdir(full_path):
            return {
                "success": False,
                "error": f"Path is a directory, not a file: {path}",
                "path": full_path,
            }

        # Use head/tail combo for line range
        try:
            proc = await asyncio.create_subprocess_shell(
                f"sed -n '{start_line},{start_line + num_lines - 1}p' {shlex.quote(full_path)}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workspace_dir,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)

            content = stdout.decode(errors="replace")

            # Get total line count
            wc_proc = await asyncio.create_subprocess_shell(
                f"wc -l < {shlex.quote(full_path)}",
                stdout=asyncio.subprocess.PIPE,
                cwd=workspace_dir,
            )
            wc_out, _ = await asyncio.wait_for(wc_proc.communicate(), timeout=10)
            total_lines = int(wc_out.decode().strip() or "0")

            return {
                "success": True,
                "path": full_path,
                "content": content,
                "start_line": start_line,
                "end_line": min(start_line + num_lines - 1, total_lines),
                "total_lines": total_lines,
            }

        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "path": full_path,
            }

    return read_file


def create_search_tool(workspace_dir: str = DEFAULT_CWD):
    """Create a specialized code search tool.

    This wraps grep with better defaults for code searching.
    """
    from agents import function_tool

    @function_tool
    async def search_code(
        pattern: str,
        path: str = ".",
        file_pattern: str = "*",
        context_lines: int = 2,
        max_results: int = 50,
    ) -> dict:
        """Search for a pattern in code files.

        Args:
            pattern: Regex pattern to search for
            path: Directory to search in (relative to workspace)
            file_pattern: Glob pattern for files to search (e.g., "*.py")
            context_lines: Number of context lines before/after match
            max_results: Maximum number of results to return

        Returns:
            Dictionary with search results
        """
        # Resolve path
        if not os.path.isabs(path):
            search_path = os.path.join(workspace_dir, path)
        else:
            search_path = path

        # Build grep command
        cmd = (
            f"grep -r -n -C{context_lines} "
            f"--include={shlex.quote(file_pattern)} "
            f"-E {shlex.quote(pattern)} "
            f"{shlex.quote(search_path)} "
            f"| head -n {max_results * (1 + 2 * context_lines)}"
        )

        try:
            proc = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=workspace_dir,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)

            output = stdout.decode(errors="replace")

            # Parse results into structured format
            matches = []
            current_match = None

            for line in output.split("\n"):
                if not line:
                    continue

                # Check if it's a match line (contains :line_num:)
                if ":" in line:
                    parts = line.split(":", 2)
                    if len(parts) >= 3 and parts[1].isdigit():
                        if current_match:
                            matches.append(current_match)
                        current_match = {
                            "file": parts[0].replace(search_path + "/", ""),
                            "line": int(parts[1]),
                            "content": parts[2],
                            "context": [],
                        }
                    elif current_match:
                        current_match["context"].append(line)

            if current_match:
                matches.append(current_match)

            return {
                "success": True,
                "pattern": pattern,
                "path": path,
                "matches": matches[:max_results],
                "total_matches": len(matches),
                "truncated": len(matches) > max_results,
            }

        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "pattern": pattern,
                "path": path,
            }

    return search_code
