"""Sandbox executor using Kubernetes Agent Sandbox.

This module provides the SandboxExecutor class that wraps the agentic_sandbox.SandboxClient
to execute commands, write files, and read files in isolated Agent Sandbox pods.

The sandbox provides:
- Isolated execution environment (gVisor/Kata containers)
- Dapr sidecar access via dapr-shared DaemonSet
- Workspace persistence between execution and testing phases
- Automatic cleanup on context exit

Usage:
    from sandbox_executor import SandboxExecutor

    with SandboxExecutor() as sandbox:
        result = sandbox.run_command("echo hello")
        sandbox.write_file("/workspace/test.py", "print('hello')")
        content = sandbox.read_file("/workspace/test.py")
"""

import base64
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

# Configuration from environment
SANDBOX_TEMPLATE = os.environ.get("SANDBOX_TEMPLATE", "dapr-agent")
SANDBOX_NAMESPACE = os.environ.get("SANDBOX_NAMESPACE", "agent-sandbox")
SANDBOX_ROUTER_URL = os.environ.get(
    "SANDBOX_ROUTER_URL",
    "http://sandbox-router-svc.agent-sandbox.svc.cluster.local:8080"
)
# Default workspace directory inside sandbox
# The python-runtime-sandbox image uses /app as working directory
SANDBOX_WORKSPACE_DIR = os.environ.get("SANDBOX_WORKSPACE_DIR", "/app")


class SandboxExecutor:
    """Execute commands in isolated Agent Sandbox pods.

    This class manages the lifecycle of an Agent Sandbox pod and provides
    methods to run commands, write files, and read files within the sandbox.

    The sandbox is created when entering the context manager and destroyed
    when exiting. This allows both execution and testing phases to share
    the same sandbox, preserving the workspace between phases.

    Attributes:
        template_name: Name of the SandboxTemplate to use
        namespace: Kubernetes namespace for the sandbox
        api_url: URL of the sandbox-router service
        workspace_dir: Default workspace directory inside the sandbox
    """

    def __init__(
        self,
        template_name: str = SANDBOX_TEMPLATE,
        namespace: str = SANDBOX_NAMESPACE,
        api_url: str = SANDBOX_ROUTER_URL,
        workspace_dir: str = SANDBOX_WORKSPACE_DIR,
    ):
        """Initialize the SandboxExecutor.

        Args:
            template_name: Name of the SandboxTemplate to use (default: dapr-agent)
            namespace: Kubernetes namespace for sandbox pods (default: agent-sandbox)
            api_url: URL of the sandbox-router service
            workspace_dir: Default workspace directory inside the sandbox
        """
        self.template_name = template_name
        self.namespace = namespace
        self.api_url = api_url
        self.workspace_dir = workspace_dir
        self._client = None
        self._entered = False

    def __enter__(self):
        """Enter the context manager and create the sandbox.

        Returns:
            self: The SandboxExecutor instance with an active sandbox
        """
        # Ensure kubectl is in PATH for port-forward mode
        # The agentic_sandbox SDK uses subprocess to run kubectl
        kubectl_paths = ["/tmp", os.path.expanduser("~/.local/bin")]
        current_path = os.environ.get("PATH", "")
        for kpath in kubectl_paths:
            if kpath not in current_path:
                os.environ["PATH"] = f"{kpath}:{current_path}"
                current_path = os.environ["PATH"]

        try:
            from agentic_sandbox import SandboxClient
        except ImportError as e:
            logger.error(
                "agentic-sandbox-client not installed. "
                "Install with: pip install agentic-sandbox-client"
            )
            raise ImportError(
                "agentic-sandbox-client is required for sandbox execution. "
                "Add it to requirements.txt or install manually."
            ) from e

        logger.info(
            f"Creating sandbox: template={self.template_name}, "
            f"namespace={self.namespace}, api_url={self.api_url or 'port-forward mode'}"
        )

        # Use port-forward mode if no router URL is configured
        # The SDK will handle kubectl port-forward automatically
        client_kwargs = {
            "template_name": self.template_name,
            "namespace": self.namespace,
        }
        # Always pass api_url when configured to use direct API connection
        # (bypasses kubectl port-forward mode which requires kubectl binary)
        if self.api_url:
            client_kwargs["api_url"] = self.api_url

        self._client = SandboxClient(**client_kwargs)
        self._client.__enter__()
        self._entered = True

        logger.info("Sandbox created successfully")
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Exit the context manager and destroy the sandbox.

        The sandbox pod is automatically cleaned up, freeing cluster resources.
        """
        if self._client and self._entered:
            logger.info("Destroying sandbox...")
            try:
                self._client.__exit__(exc_type, exc_val, exc_tb)
            except Exception as e:
                logger.warning(f"Error destroying sandbox: {e}")
            finally:
                self._client = None
                self._entered = False

    def _ensure_entered(self):
        """Ensure the context manager has been entered."""
        if not self._entered or not self._client:
            raise RuntimeError(
                "SandboxExecutor must be used as a context manager. "
                "Use 'with SandboxExecutor() as sandbox:'"
            )

    def run_command(
        self,
        command: str,
        timeout: int = 120,
        cwd: Optional[str] = None,
    ) -> dict:
        """Run a command in the sandbox.

        Args:
            command: Shell command to execute
            timeout: Timeout in seconds (default: 120)
            cwd: Working directory for the command (default: workspace_dir)

        Returns:
            dict with keys:
                - stdout: Standard output from the command
                - stderr: Standard error from the command
                - exit_code: Exit code of the command
                - success: True if exit_code == 0
        """
        self._ensure_entered()

        # Use the specified cwd or default to workspace_dir
        work_dir = cwd or self.workspace_dir

        # Wrap in shell to support cd, pipes, and shell features
        # The sandbox executes commands directly, so we need sh -c for shell syntax
        shell_command = f'/bin/sh -c "cd {work_dir} && {command}"'

        logger.debug(f"Running command in sandbox: {command[:100]}...")

        try:
            result = self._client.run(shell_command, timeout=timeout)
            return {
                "stdout": result.stdout,
                "stderr": result.stderr,
                "exit_code": result.exit_code,
                "success": result.exit_code == 0,
            }
        except Exception as e:
            logger.error(f"Command failed in sandbox: {e}")
            return {
                "stdout": "",
                "stderr": str(e),
                "exit_code": -1,
                "success": False,
            }

    def write_file(self, path: str, content: str) -> dict:
        """Write a file in the sandbox.

        Uses base64 encoding to safely pass content through the shell.

        Args:
            path: Path to the file (relative to workspace_dir or absolute)
            content: Content to write to the file

        Returns:
            dict with keys:
                - success: True if file was written successfully
                - stdout/stderr/exit_code: Command execution details
        """
        self._ensure_entered()

        # Resolve path relative to workspace if not absolute
        if not os.path.isabs(path):
            full_path = os.path.join(self.workspace_dir, path)
        else:
            full_path = path

        # Create parent directory and write file using base64 to avoid escaping issues
        encoded = base64.b64encode(content.encode()).decode()
        command = f"mkdir -p $(dirname {full_path}) && echo '{encoded}' | base64 -d > {full_path}"

        logger.debug(f"Writing file in sandbox: {path} ({len(content)} bytes)")
        return self.run_command(command)

    def read_file(self, path: str) -> dict:
        """Read a file from the sandbox.

        Args:
            path: Path to the file (relative to workspace_dir or absolute)

        Returns:
            dict with keys:
                - success: True if file was read successfully
                - content: File contents (only if success=True)
                - stdout/stderr/exit_code: Command execution details
        """
        self._ensure_entered()

        # Resolve path relative to workspace if not absolute
        if not os.path.isabs(path):
            full_path = os.path.join(self.workspace_dir, path)
        else:
            full_path = path

        logger.debug(f"Reading file from sandbox: {path}")
        result = self.run_command(f"cat {full_path}")

        if result["success"]:
            result["content"] = result["stdout"]
        else:
            result["content"] = ""

        return result

    def file_exists(self, path: str) -> bool:
        """Check if a file exists in the sandbox.

        Args:
            path: Path to check (relative to workspace_dir or absolute)

        Returns:
            True if the file exists, False otherwise
        """
        self._ensure_entered()

        # Resolve path relative to workspace if not absolute
        if not os.path.isabs(path):
            full_path = os.path.join(self.workspace_dir, path)
        else:
            full_path = path

        result = self.run_command(f"test -f {full_path}")
        return result["success"]

    def list_files(self, path: str = ".") -> dict:
        """List files in a directory in the sandbox.

        Args:
            path: Directory path (relative to workspace_dir or absolute)

        Returns:
            dict with keys:
                - success: True if listing succeeded
                - files: List of file names (only if success=True)
                - stdout/stderr/exit_code: Command execution details
        """
        self._ensure_entered()

        # Resolve path relative to workspace if not absolute
        if not os.path.isabs(path):
            full_path = os.path.join(self.workspace_dir, path)
        else:
            full_path = path

        result = self.run_command(f"ls -la {full_path}")

        if result["success"]:
            # Parse ls output into file list
            lines = result["stdout"].strip().split("\n")
            # Skip the "total" line and extract file names
            files = []
            for line in lines[1:] if lines else []:
                parts = line.split()
                if len(parts) >= 9:
                    files.append(parts[-1])
            result["files"] = files
        else:
            result["files"] = []

        return result


# ============================================================================
# Sandboxed Tool Factories
# ============================================================================

def create_sandboxed_tools(sandbox: SandboxExecutor):
    """Create execution tools that run in the sandbox.

    These tools are drop-in replacements for the local tools in workflow_agent.py,
    but they execute commands and file operations in the isolated sandbox.

    Args:
        sandbox: An active SandboxExecutor instance

    Returns:
        List of function_tool decorated functions for use with OpenAI Agents SDK
    """
    from agents import function_tool

    @function_tool
    async def run_command(command: str) -> str:
        """Run shell command in isolated sandbox.

        Args:
            command: Shell command to execute

        Returns:
            Command output or error message
        """
        result = sandbox.run_command(command)
        if result["success"]:
            output = result["stdout"]
            if result["stderr"]:
                output += f"\n[stderr]: {result['stderr']}"
            if not output.strip():
                return f"Command completed with exit code {result['exit_code']}"
            if len(output) > 5000:
                return output[:5000] + f"\n\n... (truncated, {len(output)} total chars)"
            return output
        return f"Error (exit {result['exit_code']}): {result['stderr']}"

    @function_tool
    async def write_file(file_path: str, content: str) -> str:
        """Write file in sandbox workspace.

        Args:
            file_path: Path to file (relative to workspace or absolute)
            content: Content to write

        Returns:
            Success message or error
        """
        result = sandbox.write_file(file_path, content)
        if result["success"]:
            return f"Wrote {len(content)} bytes to {file_path}"
        return f"Error writing {file_path}: {result['stderr']}"

    @function_tool
    async def read_file(file_path: str) -> str:
        """Read file from sandbox workspace.

        Args:
            file_path: Path to file (relative to workspace or absolute)

        Returns:
            File contents or error message
        """
        result = sandbox.read_file(file_path)
        if result["success"]:
            content = result["content"]
            if len(content) > 10000:
                return content[:10000] + f"\n\n... (truncated, {len(content)} total bytes)"
            return content
        return f"Error reading {file_path}: {result['stderr']}"

    @function_tool
    async def mark_task_complete(task_id: str, notes: str = "") -> str:
        """Mark a task as complete. Call after finishing each task.

        Args:
            task_id: ID of the task to mark complete
            notes: Optional notes about what was done

        Returns:
            Confirmation message
        """
        return f"Task {task_id} marked complete. {notes}"

    @function_tool
    async def run_tests(command: str) -> str:
        """Run test command in sandbox (pytest, npm test, etc.).

        Args:
            command: Test command to execute

        Returns:
            Test output or error message
        """
        # Tests get a longer timeout
        result = sandbox.run_command(command, timeout=180)
        if result["success"]:
            output = result["stdout"]
            if result["stderr"]:
                output += f"\n[stderr]: {result['stderr']}"
            if not output.strip():
                return f"Tests completed with exit code {result['exit_code']}"
            if len(output) > 8000:
                return output[:8000] + f"\n\n... (truncated, {len(output)} total chars)"
            return output
        return f"Tests failed (exit {result['exit_code']}): {result['stderr']}"

    @function_tool
    async def verify_output(task_id: str, expected: str, actual: str) -> str:
        """Verify a task's output matches expectations.

        Args:
            task_id: ID of the task being verified
            expected: Expected substring in the output
            actual: Actual output to check

        Returns:
            PASS or FAIL message
        """
        matches = expected.strip() in actual.strip()
        if matches:
            return f"Task {task_id}: PASS - Expected '{expected[:100]}' found in output"
        return f"Task {task_id}: FAIL - Expected '{expected[:100]}' not found in output"

    @function_tool
    async def check_file_exists(file_path: str) -> str:
        """Check if a file was created/modified as expected in sandbox.

        Args:
            file_path: Path to check (relative to workspace or absolute)

        Returns:
            PASS or FAIL message with file info
        """
        if sandbox.file_exists(file_path):
            # Get file size
            result = sandbox.run_command(f"stat -c %s {file_path}")
            size = result["stdout"].strip() if result["success"] else "unknown"
            return f"PASS: {file_path} exists ({size} bytes)"
        return f"FAIL: {file_path} does not exist"

    return {
        "execution": [run_command, write_file, read_file, mark_task_complete],
        "testing": [run_tests, verify_output, check_file_exists, read_file, run_command],
    }
