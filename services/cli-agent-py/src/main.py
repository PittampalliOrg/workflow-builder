"""cli-agent-py — FastAPI host for interactive-cli runtimes.

Registers Dapr workflow ``session_workflow`` (lifecycle wrapper) + activities,
runs workflow-launched CLI turns through native batch mode when enabled,
optionally supervises the headless herdr server + selected CLI TUI pane for
interactive sessions, receives CLI hook events, and serves the WS→PTY terminal
bridge. Everything is on port 8002
(uvicorn src.main:app).

Endpoint surface (parity with claude-agent-py where applicable):
  GET  /healthz, GET /readyz (readyz reports herdr as disabled when configured)
  GET  /api/v2/agent-runs/{id}/status
  POST /internal/sessions/spawn          {instanceId, payload}
  POST /internal/sessions/raise-event    {instanceId, eventName, payload}
  POST /internal/workspace/command       {command, env?, cwd?}  (X-Internal-Token)
  POST /internal/hooks/claude            (Claude Code http hooks)
  POST /internal/hooks/cli/{adapter}     (adapter command-hook relay)
  WS   /terminal/{terminal_id}?target=main|shell&cols=&rows=  (X-Internal-Token)
  POST /api/v2/agent-runs/{id}/terminate|pause|resume, DELETE /api/v2/agent-runs/{id}
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess
import sys
from contextlib import asynccontextmanager
from typing import Any, Mapping

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Startup guard: provider API-key auth env vars can silently outrank personal
# CLI OAuth credentials and flip billing from subscription to metered API. Refuse
# to boot with them present. Per-user CLI OAuth env vars delivered through
# sessionSecretEnv (CLAUDE_CODE_OAUTH_TOKEN / CODEX_AUTH_JSON / AGY_AUTH_JSON)
# are allowed and consumed by the adapters.
# ---------------------------------------------------------------------------
_FORBIDDEN_AUTH_ENV_VARS = (
    "ANTHROPIC_API_KEY",
    "CLAUDE_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "ANTIGRAVITY_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
)


def _assert_subscription_auth_only() -> None:
    present = [name for name in _FORBIDDEN_AUTH_ENV_VARS if name in os.environ]
    if present:
        logger.critical(
            "FATAL: %s set in the cli-agent-py environment. These silently "
            "outrank personal CLI OAuth credentials and flip billing from "
            "subscription to API/metered auth. Remove them from the pod spec / "
            "secret refs and redeploy. Refusing to start.",
            ", ".join(present),
        )
        sys.exit(1)


_assert_subscription_auth_only()

# Phase 2c: refuse to boot an interactive-cli pod without a durable transcript
# store (JuiceFS CSI mount). Without it the CLI silently falls back to ephemeral
# emptyDir and resume/--continue is impossible — fail loud rather than lose
# durability. Opt out with CLI_ALLOW_EPHEMERAL_TRANSCRIPT=true on non-CSI dev
# clusters.
from src.transcript_store import assert_transcript_store  # noqa: E402

assert_transcript_store()

from dapr.ext.workflow import DaprWorkflowClient, WorkflowRuntime  # noqa: E402
from fastapi import FastAPI, HTTPException, Request, Response  # noqa: E402

from src.cancellation import (  # noqa: E402
    TERMINAL_CONTROL_EVENT_TYPES,
    _save_session_cancellation_request,
    check_cancellation_activity,
)
from src.cli_lifecycle import (  # noqa: E402
    probe_cli_activity,
    start_cli_activity,
    stop_cli_activity,
)
from src.cli_batch import run_cli_once_activity  # noqa: E402
from src.hooks_api import build_router as build_hooks_router  # noqa: E402
from src.playwright_mcp_proxy import (  # noqa: E402
    build_pw_proxy_router,
    close_client as close_pw_proxy_client,
)
from src.browser_video_sync import sync_browser_video_activity  # noqa: E402
from src.workspace_diff_sync import sync_workspace_diff_activity  # noqa: E402
from src.workspace_diff_sync import sync_source_bundle_activity  # noqa: E402
from src.output_sync import sync_output_activity  # noqa: E402
from src.run_status import AgentRunNotFoundError, resolve_agent_run_status  # noqa: E402
from src.runtime_start_authority import (  # noqa: E402
    AUTHORIZE_SESSION_RUNTIME_START_ACTIVITY,
    authorize_session_runtime_start,
)
from src.seed import seed_session_activity  # noqa: E402
from src.preview_workspace import (  # noqa: E402
    PreviewWorkspaceError,
    capture_preview_workspace,
    seed_preview_workspace,
)
from src.session_supervisor import (  # noqa: E402
    SessionSupervisor,
    get_supervisor,
    set_supervisor,
)
from src.session_workflow import (  # noqa: E402
    extract_model_patch_activity,
    prepare_swebench_workspace_activity,
    session_workflow,
)
from src.taskhub import (  # noqa: E402
    LIFECYCLE_EVENT_NAME,
    raise_event as taskhub_raise_event,
    start_instance as taskhub_start_instance,
)
from src.terminal_ws import register_terminal_ws  # noqa: E402

_runtime = WorkflowRuntime()
_runtime.register_workflow(session_workflow, name="session_workflow")
_runtime.register_activity(seed_session_activity)
_runtime.register_activity(start_cli_activity)
_runtime.register_activity(run_cli_once_activity)
_runtime.register_activity(probe_cli_activity)
_runtime.register_activity(stop_cli_activity)
_runtime.register_activity(sync_output_activity)
_runtime.register_activity(sync_browser_video_activity)
_runtime.register_activity(sync_workspace_diff_activity)
_runtime.register_activity(sync_source_bundle_activity)
_runtime.register_activity(check_cancellation_activity)
_runtime.register_activity(prepare_swebench_workspace_activity)
_runtime.register_activity(extract_model_patch_activity)
_runtime.register_activity(
    authorize_session_runtime_start,
    name=AUTHORIZE_SESSION_RUNTIME_START_ACTIVITY,
)
_runtime_running = False


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _runtime_running
    logger.info("[cli-agent-py] starting Dapr workflow runtime")
    _runtime.start()
    _runtime_running = True
    supervisor = SessionSupervisor()
    set_supervisor(supervisor)
    await supervisor.start()
    try:
        yield
    finally:
        logger.info("[cli-agent-py] shutting down")
        await supervisor.stop()
        await close_pw_proxy_client()
        set_supervisor(None)
        _runtime.shutdown()
        _runtime_running = False


app = FastAPI(title="cli-agent-py", lifespan=lifespan)
app.include_router(build_hooks_router())
app.include_router(build_pw_proxy_router())
register_terminal_ws(app)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "runtime": "cli-agent-py"}


@app.get("/readyz")
async def readyz() -> Any:
    from fastapi.responses import JSONResponse

    supervisor = get_supervisor()
    herdr_ok: bool | str
    if supervisor is None:
        herdr_ok = False
    elif supervisor.disabled:
        herdr_ok = "disabled"
    else:
        herdr_ok = await supervisor.ping(timeout=2)
    ready = _runtime_running and herdr_ok is not False
    body = {
        "status": "ok" if ready else "unavailable",
        "running": _runtime_running,
        "herdr": herdr_ok,
    }
    return JSONResponse(body, status_code=200 if ready else 503)


@app.get("/api/v2/agent-runs/{instance_id}/status")
def get_agent_run_status(instance_id: str, summary: bool = False) -> dict[str, Any]:
    try:
        return resolve_agent_run_status(
            instance_id,
            summary=summary,
            app_id=os.environ.get("AGENT_SERVICE_NAME", "cli-agent-py"),
            client_factory=DaprWorkflowClient,
        )
    except AgentRunNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Spawn / raise-event (near-verbatim from claude-agent-py; blocking taskhub
# gRPC kept off the event loop via to_thread)
# ---------------------------------------------------------------------------


@app.post("/internal/sessions/spawn")
async def spawn_session_endpoint(request: dict[str, Any]) -> dict[str, Any]:
    instance_id = str(request.get("instanceId") or "").strip()
    if not instance_id:
        raise HTTPException(status_code=400, detail="instanceId is required")
    payload = request.get("payload") or {}

    try:
        await asyncio.to_thread(taskhub_start_instance, instance_id, payload)
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if "already exists" in msg.lower() or "ALREADY_EXISTS" in msg:
            logger.info("[spawn] instance %s already exists - reusing", instance_id)
        else:
            logger.exception("[spawn] StartInstance failed for %s", instance_id)
            raise HTTPException(status_code=500, detail=f"StartInstance failed: {msg}")

    return {"instanceId": instance_id, "ok": True}


def _extract_user_message_text(payload: Any) -> str | None:
    if isinstance(payload, str):
        return payload.strip() or None
    if not isinstance(payload, Mapping):
        return None
    content = payload.get("content") or payload.get("message") or payload.get("text")
    if isinstance(content, str) and content.strip():
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str) and item.strip():
                parts.append(item.strip())
            elif isinstance(item, Mapping):
                text = item.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
        if parts:
            return "\n".join(parts)
    return None


def _extract_injectable_messages(event_name: str, payload: Any) -> list[str]:
    """Pull user-message text(s) to type into the TUI from either shape:
    a direct `user.message` payload, or the BFF's `session.user_events`
    `{events: [{type: 'user.message', content}, ...]}` batch."""
    if event_name == "session.user_events" and isinstance(payload, Mapping):
        events = payload.get("events")
        texts: list[str] = []
        if isinstance(events, list):
            for event in events:
                if isinstance(event, Mapping) and event.get("type") == "user.message":
                    text = _extract_user_message_text(event)
                    if text:
                        texts.append(text)
        return texts
    text = _extract_user_message_text(payload)
    return [text] if text else []


@app.post("/internal/sessions/raise-event")
async def raise_session_event_endpoint(request: dict[str, Any]) -> dict[str, Any]:
    instance_id = str(request.get("instanceId") or "").strip()
    event_name = str(request.get("eventName") or "").strip()
    payload = request.get("payload") or {}
    if not instance_id or not event_name:
        raise HTTPException(status_code=400, detail="instanceId + eventName required")

    # User messages do NOT enter the workflow on this runtime — they are typed
    # into the TUI (goal-loop continuations + chat bridge), readiness-gated so
    # they land at the prompt rather than into a booting/working screen. The
    # INJECTION_MARKER prefix lets the UserPromptSubmit hook skip re-publishing.
    #
    # The BFF's raiseSessionUserEvents sends the canonical `session.user_events`
    # name with a `{events: [...]}` batch; a literal `user.message` is also
    # accepted for direct callers.
    if event_name in ("user.message", "session.user_events"):
        texts = _extract_injectable_messages(event_name, payload)
        if not texts:
            raise HTTPException(
                status_code=400, detail="no user.message content to inject"
            )
        supervisor = get_supervisor()
        if supervisor is None:
            raise HTTPException(status_code=503, detail="supervisor not started")
        injected_any = False
        for text in texts:
            # Use the marker the adapter selected at session start ("" for
            # codex/agy, whose composers/mirrors don't use it — sending it would
            # drop the first word). Defaults to INJECTION_MARKER for claude-code.
            if await supervisor.inject_user_text(
                text, marker=supervisor.injection_marker
            ):
                injected_any = True
        if not injected_any:
            raise HTTPException(
                status_code=409, detail="no active CLI pane to inject into"
            )
        return {"ok": True, "injected": injected_any, "count": len(texts)}

    # Terminal control events: persist the cooperative-cancel flag (claude-
    # agent-py cancellation parity) so the workflow halts on its probe path
    # even if the raised event is missed.
    if event_name in TERMINAL_CONTROL_EVENT_TYPES:
        try:
            await asyncio.to_thread(
                _save_session_cancellation_request, instance_id, event_name, payload
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[raise-event] failed to persist cancel flag for %s: %s",
                instance_id,
                exc,
            )

    event: dict[str, Any] = {"type": event_name}
    if isinstance(payload, Mapping):
        event.update(dict(payload))
    else:
        event["data"] = payload
    try:
        await asyncio.to_thread(
            taskhub_raise_event, instance_id, LIFECYCLE_EVENT_NAME, {"events": [event]}
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"RaiseEvent failed: {exc}")

    return {"ok": True}


# ---------------------------------------------------------------------------
# Workspace command (BFF git-clones session repos into /sandbox through this)
# ---------------------------------------------------------------------------

WORKSPACE_COMMAND_TIMEOUT_SECONDS = float(
    os.environ.get("CLI_WORKSPACE_COMMAND_TIMEOUT_SECONDS", "600")
)
# Hard ceiling for a per-request timeout override (a slow `npm install` / build on
# JuiceFS can take many minutes; the caller threads the node's `timeoutMs`).
WORKSPACE_COMMAND_TIMEOUT_CAP_SECONDS = float(
    os.environ.get("CLI_WORKSPACE_COMMAND_TIMEOUT_CAP_SECONDS", "1800")
)
_OUTPUT_TAIL_BYTES = 8 * 1024


def _tail(text: str | None) -> str:
    if not text:
        return ""
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= _OUTPUT_TAIL_BYTES:
        return text
    return encoded[-_OUTPUT_TAIL_BYTES:].decode("utf-8", errors="replace")


def _decode_stream(value: Any) -> str:
    """Normalize a subprocess stream to str. On the TimeoutExpired raise path
    the captured partial output is BYTES even with text=True, so a naive
    isinstance(str) check dropped it — decode bytes here so timeout tails carry
    the partial output."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _kill_process_group(proc: "subprocess.Popen[Any]") -> None:
    """SIGTERM the child's process group, then SIGKILL after a short grace, so
    grandchildren (pnpm/node/git spawned by the bash -lc command) die with the
    timed-out command instead of surviving as orphans."""
    try:
        pgid = os.getpgid(proc.pid)
    except (ProcessLookupError, OSError):
        return
    for sig, grace in ((signal.SIGTERM, 2.0), (signal.SIGKILL, None)):
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, OSError):
            return
        if grace is None:
            return
        try:
            proc.wait(timeout=grace)
            return  # exited on SIGTERM; no SIGKILL needed
        except subprocess.TimeoutExpired:
            continue


@app.post("/internal/workspace/command")
async def workspace_command_endpoint(request: Request) -> dict[str, Any]:
    expected = os.environ.get("INTERNAL_API_TOKEN", "")
    provided = request.headers.get("x-internal-token", "")
    if not expected or provided != expected:
        raise HTTPException(status_code=401, detail="invalid internal token")
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="JSON body required")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="JSON object body required")
    command = body.get("command")
    if not isinstance(command, str) or not command.strip():
        raise HTTPException(status_code=400, detail="command (string) is required")
    extra_env = body.get("env") if isinstance(body.get("env"), dict) else {}
    cwd = (
        body.get("cwd")
        if isinstance(body.get("cwd"), str) and body.get("cwd")
        else None
    )

    # Optional per-request timeout (seconds) — the workflow node's `timeoutMs`
    # threaded down so a slow install/build governs the subprocess, not the
    # 600s default. Bounded by the hard cap.
    timeout_seconds = WORKSPACE_COMMAND_TIMEOUT_SECONDS
    raw_timeout = body.get("timeout")
    if raw_timeout is not None:
        try:
            requested = float(raw_timeout)
            if requested > 0:
                timeout_seconds = min(requested, WORKSPACE_COMMAND_TIMEOUT_CAP_SECONDS)
        except (TypeError, ValueError):
            pass

    env = dict(os.environ)
    env.update({str(k): str(v) for k, v in extra_env.items() if v is not None})
    # W1: keep package-manager caches on local scratch (JuiceFS small-file I/O is
    # the build wall). /sandbox is a local emptyDir; only /sandbox/work is JuiceFS.
    env.setdefault("npm_config_cache", "/sandbox/scratch/.npm")
    env.setdefault("npm_config_store_dir", "/sandbox/scratch/.pnpm-store")
    env.setdefault("PNPM_STORE_DIR", "/sandbox/scratch/.pnpm-store")

    # Ensure local scratch dirs exist for package-manager caches. NOTE: we do not
    # symlink node_modules (npm reify deletes the symlink and rewrites it on
    # JuiceFS). Hot builds run in a LOCAL working copy via the GAN fixtures'
    # build-in-local-copy gate (tar source -> /sandbox/scratch/repo, build there).
    command = (
        "mkdir -p /sandbox/scratch/.npm /sandbox/scratch/.pnpm-store /sandbox/scratch/tmp 2>/dev/null||true; "
        + command
    )

    def _run() -> dict[str, Any]:
        # start_new_session=True puts the command in its own process group so a
        # timeout can kill the whole tree (bash -lc + pnpm/node/git children),
        # not just the direct bash child (which orphaned them under the old
        # subprocess.run path).
        proc = subprocess.Popen(
            ["bash", "-lc", command],
            cwd=cwd or os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox"),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout_seconds)
            return {
                "ok": proc.returncode == 0,
                "exit_code": proc.returncode,
                "stdout_tail": _tail(_decode_stream(stdout)),
                "stderr_tail": _tail(_decode_stream(stderr)),
            }
        except subprocess.TimeoutExpired as exc:
            _kill_process_group(proc)
            # Reap the killed group and drain whatever partial output made it to
            # the pipes; fall back to the exception's captured (bytes) output.
            drained_out, drained_err = "", ""
            try:
                drained_out, drained_err = proc.communicate(timeout=5)
            except Exception:  # noqa: BLE001
                pass
            stdout = _decode_stream(drained_out) or _decode_stream(exc.stdout)
            stderr = _decode_stream(drained_err) or _decode_stream(exc.stderr)
            return {
                "ok": False,
                "exit_code": None,
                "stdout_tail": _tail(stdout),
                "stderr_tail": _tail(
                    stderr + f"\ncommand timed out after {timeout_seconds:.0f}s"
                ),
            }

    return await asyncio.to_thread(_run)


def _require_internal_token(request: Request) -> None:
    expected = os.environ.get("INTERNAL_API_TOKEN", "")
    provided = request.headers.get("x-internal-token", "")
    if not expected or provided != expected:
        raise HTTPException(status_code=401, detail="invalid internal token")


@app.post("/internal/preview-workspace/seed")
async def preview_workspace_seed_endpoint(request: Request) -> dict[str, Any]:
    _require_internal_token(request)
    try:
        payload = await request.json()
        return await asyncio.to_thread(seed_preview_workspace, payload)
    except PreviewWorkspaceError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    except Exception as exc:  # noqa: BLE001
        logger.warning("preview workspace seed failed: %s", type(exc).__name__)
        raise HTTPException(
            status_code=500, detail="preview workspace seed failed"
        ) from exc


@app.post("/internal/preview-workspace/capture")
async def preview_workspace_capture_endpoint(request: Request) -> Response:
    _require_internal_token(request)
    try:
        payload = await request.json()
        envelope = await asyncio.to_thread(capture_preview_workspace, payload)
        return Response(
            content=envelope,
            media_type="application/vnd.wfb.preview-workspace",
        )
    except PreviewWorkspaceError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    except Exception as exc:  # noqa: BLE001
        logger.warning("preview workspace capture failed: %s", type(exc).__name__)
        raise HTTPException(
            status_code=500, detail="preview workspace capture failed"
        ) from exc


# ---------------------------------------------------------------------------
# Agent-run management surface (parity with claude-agent-py / dapr-agent-py).
# The BFF lifecycle controller + benchmark cascade invoke these over Dapr
# service-invoke.
# ---------------------------------------------------------------------------


def _agent_run_already_gone(exc: Exception) -> bool:
    msg = str(exc).lower()
    return (
        "no such instance" in msg
        or "not found" in msg
        or "does not exist" in msg
        or "no workflow" in msg
    )


@app.post("/api/v2/agent-runs/{instance_id}/terminate")
def terminate_agent_run(
    instance_id: str, body: dict[str, Any] | None = None
) -> dict[str, Any]:
    try:
        DaprWorkflowClient().terminate_workflow(instance_id=instance_id)
        return {"success": True, "instanceId": instance_id}
    except Exception as exc:  # noqa: BLE001
        if _agent_run_already_gone(exc):
            logger.info(
                "[agent-runs] terminate skipped for %s: already gone", instance_id
            )
            return {"success": True, "instanceId": instance_id, "alreadyGone": True}
        logger.error("[agent-runs] terminate failed for %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/v2/agent-runs/{instance_id}/pause")
def pause_agent_run(instance_id: str) -> dict[str, Any]:
    try:
        # SDK method is pause_workflow (dapr-ext-workflow 1.17.x); there is no
        # suspend_workflow — calling it 500s at runtime.
        DaprWorkflowClient().pause_workflow(instance_id=instance_id)
        return {"success": True, "instanceId": instance_id}
    except Exception as exc:  # noqa: BLE001
        logger.error("[agent-runs] pause failed for %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/v2/agent-runs/{instance_id}/resume")
def resume_agent_run(instance_id: str) -> dict[str, Any]:
    try:
        DaprWorkflowClient().resume_workflow(instance_id=instance_id)
        return {"success": True, "instanceId": instance_id}
    except Exception as exc:  # noqa: BLE001
        logger.error("[agent-runs] resume failed for %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.delete("/api/v2/agent-runs/{instance_id}")
def purge_agent_run(
    instance_id: str, force: bool = False, recursive: bool = False
) -> dict[str, Any]:
    try:
        DaprWorkflowClient().purge_workflow(instance_id=instance_id)
        return {
            "success": True,
            "instanceId": instance_id,
            "force": force,
            "recursive": recursive,
            "purgeAccepted": True,
            "isComplete": True,
        }
    except Exception as exc:  # noqa: BLE001
        if _agent_run_already_gone(exc):
            logger.info("[agent-runs] purge skipped for %s: already gone", instance_id)
            return {
                "success": True,
                "instanceId": instance_id,
                "force": force,
                "recursive": recursive,
                "alreadyGone": True,
                "isComplete": True,
            }
        logger.error("[agent-runs] purge failed for %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))
