"""dev-sync exec bridge (#40) — python twin of exec-bridge.mjs.

Runs INSIDE a python dev image's app container (started by the
`skaffold/dev/<svc>/Dockerfile.dev` entrypoint alongside `uvicorn --reload`) so
allowlisted deps/test commands execute with the app's real toolchain — the
node-only dev-sync-sidecar cannot run `python -m pytest` (live repro: exit 127).
The sidecar's `/__run` proxies to this bridge over pod-localhost and falls back
to local execution when the bridge is absent (`executedIn: "app" | "sidecar"`).

SECURITY: binds 127.0.0.1 ONLY (pod-local), requires the shared sync token when
set, and runs NOTHING but the named entries of DEV_SYNC_COMMANDS_JSON
(fail-closed: absent/malformed env means every /__exec 404s).

Env (stamped into the app container by sandbox-execution-api in sidecar mode):
  DEV_SYNC_EXEC_PORT      (default 8002)   - 127.0.0.1 listen port
  DEV_SYNC_DEST           (default /app)   - command cwd (the synced workdir)
  DEV_SYNC_TOKEN          (optional)       - require matching `x-sync-token`
  DEV_SYNC_COMMANDS_JSON  (optional)       - {"<name>": "<shell command>"} allowlist
  DEV_SYNC_RUN_TIMEOUT_MS (default 900000) - hard kill for a child

Endpoints: POST /__exec?cmd=<name> - GET /healthz
Response contract mirrors the sidecar /__run (keep in lockstep with
exec-bridge.mjs):
  200 {ok, cmd, exitCode, durationMs, truncated, output}  - the command RAN
  4xx/5xx {ok: false, error, ...}                         - it did NOT run

Stdlib only — python dev images need no extra dependency.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("DEV_SYNC_EXEC_PORT") or 8002)
DEST = os.environ.get("DEV_SYNC_DEST") or "/app"
TOKEN = os.environ.get("DEV_SYNC_TOKEN") or ""
RUN_TIMEOUT_MS = int(os.environ.get("DEV_SYNC_RUN_TIMEOUT_MS") or 900000)
RUN_OUTPUT_CAP = 64 * 1024


def _log(msg: str) -> None:
    print(f"[dev-sync-exec-bridge] {msg}", flush=True)


def load_commands() -> dict[str, str]:
    raw = (os.environ.get("DEV_SYNC_COMMANDS_JSON") or "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError as e:
        _log(f"invalid DEV_SYNC_COMMANDS_JSON (ignored): {e}")
        return {}
    if not isinstance(parsed, dict):
        _log("DEV_SYNC_COMMANDS_JSON must be a JSON object (ignored)")
        return {}
    return {
        k: v for k, v in parsed.items() if isinstance(v, str) and v.strip()
    }


COMMANDS = load_commands()


class Handler(BaseHTTPRequestHandler):
    # Quiet the default per-request stderr lines; we log runs ourselves.
    def log_message(self, *_args) -> None:  # noqa: N802 (http.server API)
        pass

    def _reply(self, code: int, body: dict) -> None:
        try:
            payload = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass  # socket already gone

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        path = urlparse(self.path).path
        if path in ("/healthz", "/"):
            return self._reply(
                200,
                {
                    "ok": True,
                    "service": "dev-sync-exec-bridge",
                    "dest": DEST,
                    "commands": sorted(COMMANDS),
                },
            )
        return self._reply(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 (http.server API)
        url = urlparse(self.path)
        if url.path != "/__exec":
            return self._reply(404, {"ok": False, "error": "not found"})
        if TOKEN and self.headers.get("x-sync-token") != TOKEN:
            return self._reply(401, {"ok": False, "error": "unauthorized"})
        # Drain+ignore any body (cmd comes from the query only).
        length = int(self.headers.get("content-length") or 0)
        if length:
            self.rfile.read(length)
        name = (parse_qs(url.query).get("cmd", [""])[0] or "").strip()
        if not name:
            return self._reply(400, {"ok": False, "error": "missing cmd"})
        command = COMMANDS.get(name)
        if not command:
            return self._reply(
                404,
                {
                    "ok": False,
                    "error": f'unknown command "{name}"',
                    "allowed": sorted(COMMANDS),
                },
            )

        t0 = time.monotonic()
        extra: dict[str, object] = {}
        try:
            proc = subprocess.run(
                ["sh", "-c", command],
                cwd=DEST,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=RUN_TIMEOUT_MS / 1000,
            )
            exit_code = proc.returncode
            raw_output = proc.stdout or b""
        except subprocess.TimeoutExpired as e:
            exit_code = -1
            raw_output = e.stdout or b""
            extra["signal"] = "SIGKILL"  # parity with the node bridge's timeout kill
        except OSError as e:
            return self._reply(500, {"ok": False, "cmd": name, "error": f"spawn: {e}"})

        truncated = len(raw_output) > RUN_OUTPUT_CAP
        output = raw_output[:RUN_OUTPUT_CAP].decode("utf-8", errors="replace")
        duration_ms = int((time.monotonic() - t0) * 1000)
        _log(f'run "{name}" exit={exit_code} ({duration_ms}ms)')
        self._reply(
            200,
            {
                "ok": exit_code == 0,
                "cmd": name,
                "exitCode": exit_code,
                "durationMs": duration_ms,
                "truncated": truncated,
                "output": output,
                **extra,
            },
        )


def main() -> None:
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        # Background child of the dev entrypoint: never take the dev server
        # down over a listen failure — log and exit.
        _log(f"listen failed: {e} — exec bridge disabled")
        sys.exit(1)
    _log(
        f"listening on 127.0.0.1:{PORT} (cwd {DEST})"
        + (
            f" commands: {', '.join(sorted(COMMANDS))}"
            if COMMANDS
            else " (no commands — /__exec fails closed)"
        )
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
