"""cli-agent-py — FastAPI host for interactive-cli runtimes.

Registers Dapr workflow ``session_workflow`` (lifecycle wrapper) + activities,
supervises the headless herdr server + selected CLI TUI pane, receives CLI hook
events, and serves the WS→PTY terminal bridge. Everything is on port 8002
(uvicorn src.main:app).

Endpoint surface (parity with claude-agent-py where applicable):
  GET  /healthz, GET /readyz (readyz also pings the herdr socket)
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

from dapr.ext.workflow import DaprWorkflowClient, WorkflowRuntime  # noqa: E402
from fastapi import FastAPI, HTTPException, Request  # noqa: E402

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
from src.hooks_api import build_router as build_hooks_router  # noqa: E402
from src.output_sync import sync_output_activity  # noqa: E402
from src.seed import seed_session_activity  # noqa: E402
from src.session_supervisor import (  # noqa: E402
    SessionSupervisor,
    get_supervisor,
    set_supervisor,
)
from src.session_workflow import session_workflow  # noqa: E402
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
_runtime.register_activity(probe_cli_activity)
_runtime.register_activity(stop_cli_activity)
_runtime.register_activity(sync_output_activity)
_runtime.register_activity(check_cancellation_activity)
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
        set_supervisor(None)
        _runtime.shutdown()
        _runtime_running = False


app = FastAPI(title="cli-agent-py", lifespan=lifespan)
app.include_router(build_hooks_router())
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
    body = {"status": "ok" if ready else "unavailable", "running": _runtime_running, "herdr": herdr_ok}
    return JSONResponse(body, status_code=200 if ready else 503)


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
            raise HTTPException(status_code=400, detail="no user.message content to inject")
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
            raise HTTPException(status_code=409, detail="no active CLI pane to inject into")
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
                "[raise-event] failed to persist cancel flag for %s: %s", instance_id, exc
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
_OUTPUT_TAIL_BYTES = 8 * 1024


def _tail(text: str | None) -> str:
    if not text:
        return ""
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= _OUTPUT_TAIL_BYTES:
        return text
    return encoded[-_OUTPUT_TAIL_BYTES:].decode("utf-8", errors="replace")


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
    cwd = body.get("cwd") if isinstance(body.get("cwd"), str) and body.get("cwd") else None

    env = dict(os.environ)
    env.update({str(k): str(v) for k, v in extra_env.items() if v is not None})

    def _run() -> dict[str, Any]:
        try:
            completed = subprocess.run(
                ["bash", "-lc", command],
                cwd=cwd or os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox"),
                env=env,
                capture_output=True,
                text=True,
                timeout=WORKSPACE_COMMAND_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            return {
                "ok": False,
                "exit_code": None,
                "stdout_tail": _tail(exc.stdout if isinstance(exc.stdout, str) else ""),
                "stderr_tail": _tail(
                    (exc.stderr if isinstance(exc.stderr, str) else "")
                    + f"\ncommand timed out after {WORKSPACE_COMMAND_TIMEOUT_SECONDS:.0f}s"
                ),
            }
        return {
            "ok": completed.returncode == 0,
            "exit_code": completed.returncode,
            "stdout_tail": _tail(completed.stdout),
            "stderr_tail": _tail(completed.stderr),
        }

    return await asyncio.to_thread(_run)


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
            logger.info("[agent-runs] terminate skipped for %s: already gone", instance_id)
            return {"success": True, "instanceId": instance_id, "alreadyGone": True}
        logger.error("[agent-runs] terminate failed for %s: %s", instance_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/v2/agent-runs/{instance_id}/pause")
def pause_agent_run(instance_id: str) -> dict[str, Any]:
    try:
        DaprWorkflowClient().suspend_workflow(instance_id=instance_id)
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
