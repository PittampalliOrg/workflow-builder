"""OpenShell sandbox runtime used by dapr-agent-py's existing tools."""

from __future__ import annotations

import json
import logging
import os
import posixpath
import shlex
import threading
from textwrap import dedent
from typing import Any

from openshell import SandboxClient, SandboxSession

SANDBOX_NAME_ENV = "OPENSHELL_SANDBOX_NAME"
SANDBOX_CWD_ENV = "OPENSHELL_CWD"
DEFAULT_CWD = "/sandbox"
DEFAULT_TIMEOUT_SECONDS = 30 * 60

logger = logging.getLogger(__name__)


def _merge_output(stdout: str, stderr: str) -> str:
    if stdout and stderr:
        return f"{stdout.rstrip()}\n{stderr.rstrip()}"
    return stdout or stderr


class OpenShellRuntime:
    """Process-local OpenShell session manager."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._session: SandboxSession | None = None
        self._sandbox_name: str | None = None
        self._cwd = os.environ.get(SANDBOX_CWD_ENV, DEFAULT_CWD)

    @property
    def cwd(self) -> str:
        return self._cwd

    @property
    def sandbox_name(self) -> str:
        self._ensure_session()
        return self._sandbox_name or "unknown"

    def set_sandbox_name(self, name: str | None) -> None:
        """Target an orchestrator-assigned OpenShell sandbox."""
        normalized = (name or "").strip()
        if self._sandbox_name != normalized:
            with self._lock:
                self._session = None
                self._sandbox_name = normalized or None
        if normalized:
            os.environ[SANDBOX_NAME_ENV] = normalized
        else:
            os.environ.pop(SANDBOX_NAME_ENV, None)

    def set_cwd(self, cwd: str | None) -> None:
        """Set the working directory used for relative paths and commands."""
        if not cwd or not cwd.strip():
            normalized = DEFAULT_CWD
        else:
            normalized = self.resolve_path(cwd)
        self._cwd = normalized
        os.environ[SANDBOX_CWD_ENV] = normalized

    def resolve_path(self, path: str | None) -> str:
        raw = (path or ".").strip() or "."
        if raw == "~":
            raw = DEFAULT_CWD
        elif raw.startswith("~/"):
            raw = posixpath.join(DEFAULT_CWD, raw[2:])
        if posixpath.isabs(raw):
            return posixpath.normpath(raw)
        base = os.environ.get(SANDBOX_CWD_ENV) or self._cwd or DEFAULT_CWD
        return posixpath.normpath(posixpath.join(base, raw))

    def _ensure_session(self) -> SandboxSession:
        if self._session is not None:
            return self._session

        with self._lock:
            if self._session is not None:
                return self._session

            client = SandboxClient.from_active_cluster()
            configured_name = os.environ.get(SANDBOX_NAME_ENV, "").strip()
            if not configured_name:
                raise RuntimeError(
                    "OpenShell sandboxName is required. The workflow must pass "
                    "workspace_profile.sandboxName into dapr-agent-py before tools run."
                )

            ref = client.get(configured_name)
            ref = client.wait_ready(ref.name)
            self._sandbox_name = ref.name
            self._session = SandboxSession(client, ref)
            return self._session

    def _exec(
        self,
        argv: list[str],
        *,
        stdin: bytes | None = None,
        timeout_seconds: int | None = None,
    ) -> dict[str, Any]:
        session = self._ensure_session()
        result = session.exec(
            argv,
            stdin=stdin,
            timeout_seconds=timeout_seconds or DEFAULT_TIMEOUT_SECONDS,
        )
        return {
            "ok": result.exit_code == 0,
            "exit_code": result.exit_code,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "output": _merge_output(result.stdout, result.stderr),
            "sandbox_name": self.sandbox_name,
        }

    def execute(self, command: str, timeout_seconds: int | None = None) -> dict[str, Any]:
        """Run a shell command in the current sandbox working directory.

        The command is piped via stdin to avoid OpenShell's argv newline
        restriction. This mirrors how run_python safely handles multi-line
        content via stdin.
        """
        cwd = shlex.quote(self._cwd)
        full_script = f"cd {cwd} && {command}"
        return self._exec(
            ["bash", "-l"],
            stdin=full_script.encode("utf-8"),
            timeout_seconds=timeout_seconds,
        )

    def run_python(
        self,
        script: str,
        payload: dict[str, Any] | None = None,
        timeout_seconds: int | None = None,
    ) -> dict[str, Any]:
        # Embed the JSON payload as a variable assignment at the top of the
        # script, then pipe the whole thing via stdin to avoid OpenShell's
        # argv newline restriction.
        payload_json = json.dumps(payload or {})
        full_script = (
            f"import sys as _sys; _sys.stdin = __import__('io').StringIO({payload_json!r})\n"
            + script
        )
        return self._exec(
            ["python3"],
            stdin=full_script.encode("utf-8"),
            timeout_seconds=timeout_seconds,
        )

    def stat_path(self, path: str) -> dict[str, Any]:
        script = dedent(
            """
            import json, pathlib, sys
            payload = json.loads(sys.stdin.read())
            p = pathlib.Path(payload["path"])
            if not p.exists():
                print(json.dumps({"ok": True, "exists": False, "path": str(p)}))
                raise SystemExit(0)
            st = p.stat()
            print(json.dumps({
                "ok": True,
                "exists": True,
                "path": str(p),
                "is_file": p.is_file(),
                "is_dir": p.is_dir(),
                "size": st.st_size,
                "mtime": st.st_mtime,
            }))
            """
        ).strip()
        return self._json_result(script, {"path": path})

    def read_file_lines(self, path: str, offset: int, limit: int) -> dict[str, Any]:
        script = dedent(
            """
            import json, pathlib, sys
            payload = json.loads(sys.stdin.read())
            p = pathlib.Path(payload["path"])
            offset = int(payload["offset"])
            limit = int(payload["limit"])
            lines_out = []
            total_lines = 0
            start_line = 0
            end_line = 0
            try:
                with p.open(encoding="utf-8", errors="replace") as handle:
                    for line_no, line_text in enumerate(handle, start=1):
                        total_lines = line_no
                        if line_no <= offset:
                            continue
                        if len(lines_out) >= limit:
                            continue
                        if not lines_out:
                            start_line = line_no
                        end_line = line_no
                        lines_out.append(line_text.rstrip("\\n").rstrip("\\r"))
            except Exception as exc:
                print(json.dumps({"ok": False, "error": str(exc)}))
                raise SystemExit(0)
            print(json.dumps({
                "ok": True,
                "lines": lines_out,
                "total_lines": total_lines,
                "start_line": start_line,
                "end_line": end_line,
            }))
            """
        ).strip()
        return self._json_result(script, {"path": path, "offset": offset, "limit": limit})

    def read_text(self, path: str) -> dict[str, Any]:
        script = dedent(
            """
            import json, pathlib, sys
            payload = json.loads(sys.stdin.read())
            p = pathlib.Path(payload["path"])
            try:
                print(json.dumps({"ok": True, "content": p.read_text(encoding="utf-8")}))
            except Exception as exc:
                print(json.dumps({"ok": False, "error": str(exc)}))
            """
        ).strip()
        return self._json_result(script, {"path": path})

    def write_text(self, path: str, content: str) -> dict[str, Any]:
        script = dedent(
            """
            import json, pathlib, sys
            payload = json.loads(sys.stdin.read())
            p = pathlib.Path(payload["path"])
            try:
                existed = p.exists()
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(payload["content"], encoding="utf-8")
                print(json.dumps({"ok": True, "existed": existed, "path": str(p)}))
            except Exception as exc:
                print(json.dumps({"ok": False, "error": str(exc)}))
            """
        ).strip()
        return self._json_result(script, {"path": path, "content": content})

    def glob_files(self, pattern: str, search_dir: str, max_results: int) -> dict[str, Any]:
        script = dedent(
            """
            import json, pathlib, sys
            payload = json.loads(sys.stdin.read())
            search_path = pathlib.Path(payload["search_dir"])
            pattern = payload["pattern"]
            if not search_path.is_dir():
                print(json.dumps({"ok": False, "error": "directory_not_found", "path": str(search_path)}))
                raise SystemExit(0)
            try:
                files = [p for p in search_path.glob(pattern) if p.is_file()]
                files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                total = len(files)
                files = files[: int(payload["max_results"])]
                print(json.dumps({
                    "ok": True,
                    "search_dir": str(search_path),
                    "pattern": pattern,
                    "matches": [str(p) for p in files],
                    "total": total,
                }))
            except Exception as exc:
                print(json.dumps({"ok": False, "error": str(exc)}))
            """
        ).strip()
        return self._json_result(
            script,
            {"pattern": pattern, "search_dir": search_dir, "max_results": max_results},
        )

    def _json_result(self, script: str, payload: dict[str, Any]) -> dict[str, Any]:
        raw = self.run_python(script, payload)
        if not raw["ok"]:
            return raw
        try:
            parsed = json.loads(raw["stdout"])
        except json.JSONDecodeError:
            return {
                "ok": False,
                "error": "invalid_json",
                "stdout": raw["stdout"],
                "stderr": raw["stderr"],
            }
        return parsed


_RUNTIME = OpenShellRuntime()


def get_runtime() -> OpenShellRuntime:
    return _RUNTIME
