"""OpenShell sandbox runtime used by dapr-agent-py's existing tools."""

from __future__ import annotations

import json
import logging
import os
import posixpath
import shlex
import contextvars
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
        # Session id for the currently-running workflow entry. Set by
        # session_workflow / agent_workflow at entry time (non-replaying)
        # so built-in tools like read_session_events can scope to the
        # caller's session without the agent having to pass it. Unset
        # (None) for non-session-bound invocations.
        self._session_id: str | None = None

    @property
    def cwd(self) -> str:
        return self._cwd

    @property
    def sandbox_name(self) -> str:
        self._ensure_session()
        return self._sandbox_name or "unknown"

    @property
    def configured_sandbox_name(self) -> str | None:
        return self._sandbox_name

    @property
    def session_id(self) -> str | None:
        return self._session_id

    def set_session_id(self, session_id: str | None) -> None:
        """Attach the current CMA session id to this runtime (process-local).

        Called from workflow entry points so tools in the same process can
        scope reads/writes to the caller's session without the agent
        manually passing the id.
        """
        self._session_id = (session_id or "").strip() or None

    def set_sandbox_name(self, name: str | None) -> None:
        """Target an orchestrator-assigned OpenShell sandbox."""
        normalized = (name or "").strip()
        if self._sandbox_name != normalized:
            with self._lock:
                self._session = None
                self._sandbox_name = normalized or None

    def set_cwd(self, cwd: str | None) -> None:
        """Set the working directory used for relative paths and commands."""
        if not cwd or not cwd.strip():
            normalized = DEFAULT_CWD
        else:
            normalized = self.resolve_path(cwd)
        self._cwd = normalized

    def resolve_path(self, path: str | None) -> str:
        raw = (path or ".").strip() or "."
        if raw == "~":
            raw = DEFAULT_CWD
        elif raw.startswith("~/"):
            raw = posixpath.join(DEFAULT_CWD, raw[2:])
        if posixpath.isabs(raw):
            return posixpath.normpath(raw)
        base = self._cwd or os.environ.get(SANDBOX_CWD_ENV) or DEFAULT_CWD
        return posixpath.normpath(posixpath.join(base, raw))

    def _ensure_session(self) -> SandboxSession:
        if self._session is not None:
            return self._session

        with self._lock:
            if self._session is not None:
                return self._session

            client = SandboxClient.from_active_cluster()
            configured_name = (
                self._sandbox_name or os.environ.get(SANDBOX_NAME_ENV, "")
            ).strip()
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

    def read_bytes_base64(
        self, path: str, max_bytes: int = 100 * 1024 * 1024
    ) -> dict[str, Any]:
        """Read any file in the sandbox and return base64-encoded contents.
        Handles arbitrarily-large files up to ``max_bytes`` via chunked
        reads — writes base64 to a sandbox-side temp file, then pulls it
        back in 512 KB stdout chunks so we don't hit OpenShell's practical
        throughput cap on a single exec call.

        For small files (<256 KB raw, ~350 KB base64) the fast path returns
        in one shot. Larger files switch to the chunked path; callers don't
        need to know which mode fired.
        """
        # Fast path: single-shot read for small files
        fast = self._read_bytes_single_shot(path, max_bytes, fast_threshold=256 * 1024)
        if fast.get("ok") or fast.get("error") != "use_chunked":
            return fast
        # Chunked path: stage base64 to /tmp/<ref>, pull in 512 KB stdout chunks
        return self._read_bytes_chunked(path, max_bytes)

    def _read_bytes_single_shot(
        self, path: str, max_bytes: int, fast_threshold: int
    ) -> dict[str, Any]:
        script = dedent(
            """
            import base64, json, pathlib, sys
            payload = json.loads(sys.stdin.read())
            p = pathlib.Path(payload["path"])
            max_bytes = int(payload["max_bytes"])
            fast_threshold = int(payload["fast_threshold"])
            try:
                if not p.is_file():
                    print(json.dumps({"ok": False, "error": "not_a_file", "path": str(p)}))
                    raise SystemExit(0)
                size = p.stat().st_size
                if size > max_bytes:
                    print(json.dumps({
                        "ok": False,
                        "error": "too_large",
                        "size": size,
                        "max_bytes": max_bytes,
                    }))
                    raise SystemExit(0)
                if size > fast_threshold:
                    # Let the caller switch to chunked mode.
                    print(json.dumps({
                        "ok": False,
                        "error": "use_chunked",
                        "size": size,
                    }))
                    raise SystemExit(0)
                with p.open("rb") as handle:
                    data = handle.read()
                print(json.dumps({
                    "ok": True,
                    "path": str(p),
                    "size": size,
                    "base64": base64.b64encode(data).decode("ascii"),
                }))
            except SystemExit:
                raise
            except Exception as exc:
                print(json.dumps({"ok": False, "error": str(exc)}))
            """
        ).strip()
        return self._json_result(
            script,
            {"path": path, "max_bytes": max_bytes, "fast_threshold": fast_threshold},
        )

    def _read_bytes_chunked(
        self, path: str, max_bytes: int
    ) -> dict[str, Any]:
        """Stage base64(bytes) to a sandbox temp file, then pull fixed-size
        stdout chunks back. Chunk size matches a safe stdout payload window.
        Total time is O(size / chunk_size) round-trips — small for files
        under a few MB, acceptable for artifacts up to 100 MB.
        """
        import uuid

        chunk_size = 512 * 1024  # base64 chars per chunk; ~384 KB raw
        staging_ref = f"/tmp/wb-upload-{uuid.uuid4().hex}.b64"
        stage_script = dedent(
            """
            import base64, json, pathlib, sys
            payload = json.loads(sys.stdin.read())
            src = pathlib.Path(payload["src"])
            dst = pathlib.Path(payload["dst"])
            max_bytes = int(payload["max_bytes"])
            try:
                if not src.is_file():
                    print(json.dumps({"ok": False, "error": "not_a_file"}))
                    raise SystemExit(0)
                size = src.stat().st_size
                if size > max_bytes:
                    print(json.dumps({
                        "ok": False,
                        "error": "too_large",
                        "size": size,
                        "max_bytes": max_bytes,
                    }))
                    raise SystemExit(0)
                with src.open("rb") as handle:
                    encoded = base64.b64encode(handle.read())
                dst.write_bytes(encoded)
                print(json.dumps({
                    "ok": True,
                    "size": size,
                    "b64_size": len(encoded),
                    "staging_ref": str(dst),
                }))
            except SystemExit:
                raise
            except Exception as exc:
                print(json.dumps({"ok": False, "error": str(exc)}))
            """
        ).strip()
        stage = self._json_result(
            stage_script,
            {"src": path, "dst": staging_ref, "max_bytes": max_bytes},
        )
        if not stage.get("ok"):
            return stage

        b64_size = int(stage["b64_size"])
        chunks: list[str] = []
        offset = 0
        while offset < b64_size:
            chunk_end = min(offset + chunk_size, b64_size)
            read_script = dedent(
                """
                import json, pathlib, sys
                payload = json.loads(sys.stdin.read())
                p = pathlib.Path(payload["path"])
                start = int(payload["start"])
                end = int(payload["end"])
                with p.open("rb") as handle:
                    handle.seek(start)
                    data = handle.read(end - start)
                print(json.dumps({"ok": True, "chunk": data.decode("ascii")}))
                """
            ).strip()
            chunk_res = self._json_result(
                read_script,
                {"path": staging_ref, "start": offset, "end": chunk_end},
            )
            if not chunk_res.get("ok"):
                # Clean up the staging file before returning the error.
                self._exec(
                    ["rm", "-f", staging_ref],
                    timeout_seconds=10,
                )
                return chunk_res
            chunks.append(chunk_res["chunk"])
            offset = chunk_end

        # Remove staging file; fire-and-forget, chunks are already in memory.
        self._exec(["rm", "-f", staging_ref], timeout_seconds=10)

        return {
            "ok": True,
            "path": path,
            "size": int(stage["size"]),
            "base64": "".join(chunks),
        }

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


_DEFAULT_RUNTIME = OpenShellRuntime()
_RUNTIME_CONTEXT: contextvars.ContextVar[OpenShellRuntime | None] = (
    contextvars.ContextVar("openshell_runtime", default=None)
)


def get_runtime() -> OpenShellRuntime:
    return _RUNTIME_CONTEXT.get() or _DEFAULT_RUNTIME


def bind_runtime(
    *,
    sandbox_name: str | None = None,
    cwd: str | None = None,
    session_id: str | None = None,
) -> tuple[OpenShellRuntime, contextvars.Token[OpenShellRuntime | None]]:
    runtime = OpenShellRuntime()
    runtime.set_sandbox_name(sandbox_name)
    runtime.set_cwd(cwd or DEFAULT_CWD)
    runtime.set_session_id(session_id)
    token = _RUNTIME_CONTEXT.set(runtime)
    return runtime, token


def reset_runtime(token: contextvars.Token[OpenShellRuntime | None]) -> None:
    _RUNTIME_CONTEXT.reset(token)
