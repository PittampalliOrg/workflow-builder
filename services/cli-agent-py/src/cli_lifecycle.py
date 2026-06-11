"""CLI pane lifecycle activities: start_cli_activity / probe_cli_activity /
stop_cli_activity.

Activities run on Dapr workflow worker threads, so each creates a short-lived
HerdrClient bound to its own ``asyncio.run`` loop (the supervisor's client lives
on the FastAPI app loop and must not be shared across loops).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Mapping

from src.cli_adapters import get_adapter
from src.herdr_client import (
    AGENT_STATUS_DONE,
    AGENT_STATUS_UNKNOWN,
    HerdrClient,
    HerdrError,
    agent_status_of,
    pane_id_of,
)
from src.seed import adapter_name_for
from src.session_supervisor import HERDR_DISABLED, get_supervisor

logger = logging.getLogger(__name__)

AGENT_DETECT_TIMEOUT_SECONDS = float(
    os.environ.get("CLI_AGENT_DETECT_TIMEOUT_SECONDS", "20")
)
STOP_WAIT_SECONDS = float(os.environ.get("CLI_STOP_WAIT_SECONDS", "10"))


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _clean(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _sandbox_root() -> str:
    return os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")


# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------


def start_cli_activity(
    _ctx_or_input: Any, input_data: dict[str, Any] | None = None
) -> dict[str, Any]:
    payload = input_data if input_data is not None else _ctx_or_input
    return asyncio.run(_start_cli(_record(payload)))


async def _start_cli(input_data: dict[str, Any]) -> dict[str, Any]:
    session_id = str(input_data.get("sessionId") or "") or None
    instance_id = str(input_data.get("instanceId") or "") or None
    agent_config = _record(input_data.get("agentConfig"))
    seed = _record(input_data.get("seed"))
    seed_paths = {
        str(k): str(v) for k, v in _record(seed.get("paths")).items() if v is not None
    }
    adapter = get_adapter(adapter_name_for(input_data))
    argv = adapter.build_argv(agent_config, seed_paths)
    env = adapter.pane_env(os.environ, session_id=session_id)
    cwd = _sandbox_root()

    if HERDR_DISABLED:
        # Unit-test escape hatch — report the launch plan without herdr.
        return {
            "paneRef": "disabled",
            "argv": argv,
            "agentDetected": False,
            "herdrDisabled": True,
        }

    client = HerdrClient()
    try:
        # VERIFIED: agent.start creates its own workspace/pane and runs argv —
        # no prior workspace.create needed. The name doubles as the pane label
        # and an agent.get target.
        started = await client.agent_start(
            name=session_id or "wfb-cli", argv=argv, cwd=cwd, env=env
        )
        pane_ref = pane_id_of(started)
        if not pane_ref:
            raise RuntimeError(f"agent.start returned no pane reference: {started}")

        agent_detected = await _wait_for_agent(client, pane_ref)
        if not agent_detected:
            # Don't raise: the pane is live and a retry would double-launch the
            # TUI. The supervisor's event stream + the workflow's probe path
            # converge on the true state.
            logger.warning(
                "[start-cli] agent not detected within %.0fs (pane=%s) — continuing",
                AGENT_DETECT_TIMEOUT_SECONDS,
                pane_ref,
            )

        supervisor = get_supervisor()
        if supervisor is not None:
            supervisor.register_session(
                session_id=session_id, instance_id=instance_id, pane_ref=pane_ref
            )
            # Kickoff: type the seed prompt into the TUI once it reaches its
            # prompt (readiness-gated, scheduled onto the app loop — this
            # activity runs on a throwaway worker-thread loop). Skipped for
            # adapters that require an interactive in-pane login first (agy
            # device-code OAuth) — the seed must never land in the auth prompt.
            seed_text = _clean(input_data.get("seedUserMessage"))
            if seed_text and not adapter.requires_interactive_login:
                from src.hooks_api import INJECTION_MARKER

                supervisor.arm_seed(seed_text, marker=INJECTION_MARKER)
            elif seed_text and adapter.requires_interactive_login:
                logger.info(
                    "[start-cli] adapter=%s requires interactive login — "
                    "deferring kickoff to the user (post-auth)",
                    adapter.name,
                )
        return {"paneRef": pane_ref, "argv": argv, "agentDetected": agent_detected}
    finally:
        await client.close()


async def _wait_for_agent(client: HerdrClient, pane_ref: str) -> bool:
    """True once herdr DETECTS the agent (status leaves ``unknown`` or a
    detected/reported agent label appears). ``agent.get`` answers immediately
    for any started pane with status ``unknown`` — that is NOT detection."""
    deadline = time.monotonic() + AGENT_DETECT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        try:
            result = await client.agent_get(pane_ref)
            if _is_detected(result):
                return True
        except HerdrError:
            pass  # pane not registered yet
        except Exception as exc:  # noqa: BLE001
            logger.debug("[start-cli] agent.get probe failed: %s", exc)
        await asyncio.sleep(1.0)
    return False


def _is_detected(result: Mapping[str, Any]) -> bool:
    status = agent_status_of(result)
    if status and status != AGENT_STATUS_UNKNOWN:
        return True
    agent = result.get("agent")
    # agent.get nests under "agent"; a detected/reported label shows up as a
    # STRING "agent" field inside it (e.g. {"agent": "claude", ...}).
    if isinstance(agent, Mapping) and isinstance(agent.get("agent"), str):
        return True
    return False


# ---------------------------------------------------------------------------
# probe
# ---------------------------------------------------------------------------


def probe_cli_activity(
    _ctx_or_input: Any, input_data: dict[str, Any] | None = None
) -> dict[str, Any]:
    payload = input_data if input_data is not None else _ctx_or_input
    return asyncio.run(_probe_cli(_record(payload)))


async def _probe_cli(input_data: dict[str, Any]) -> dict[str, Any]:
    """Out-of-band liveness probe for the idle-timer path of the workflow.

    Returns ``{"terminal": bool, "status": ..., "reason": ...}``.
    """
    if HERDR_DISABLED:
        return {"terminal": False, "status": None, "reason": "herdr_disabled"}
    pane_ref = str(input_data.get("paneRef") or "") or None
    client = HerdrClient()
    try:
        try:
            await client.ping(timeout=3)
        except Exception as exc:  # noqa: BLE001
            return {
                "terminal": True,
                "status": "failed",
                "reason": f"herdr_unreachable: {exc}",
            }
        if not pane_ref:
            return {"terminal": False, "status": None, "reason": "no_pane_ref"}
        try:
            agent = await client.agent_get(pane_ref)
        except HerdrError as exc:
            return {"terminal": True, "status": "failed", "reason": f"pane_gone: {exc}"}
        except Exception as exc:  # noqa: BLE001
            return {"terminal": False, "status": None, "reason": f"probe_error: {exc}"}
        status = agent_status_of(agent)
        if status == AGENT_STATUS_DONE:
            return {"terminal": True, "status": "completed", "reason": "agent_done"}
        return {"terminal": False, "status": status, "reason": None}
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# stop
# ---------------------------------------------------------------------------


def stop_cli_activity(
    _ctx_or_input: Any, input_data: dict[str, Any] | None = None
) -> dict[str, Any]:
    payload = input_data if input_data is not None else _ctx_or_input
    return asyncio.run(_stop_cli(_record(payload)))


async def _stop_cli(input_data: dict[str, Any]) -> dict[str, Any]:
    """Cooperative, idempotent TUI close: '/exit' + Enter, bounded wait, then
    pane.close. Every step tolerates the pane/server already being gone."""
    if HERDR_DISABLED:
        return {"ok": True, "herdrDisabled": True}
    pane_ref = str(input_data.get("paneRef") or "") or None
    if not pane_ref:
        return {"ok": True, "reason": "no_pane_ref"}
    client = HerdrClient()
    closed_cooperatively = False
    try:
        try:
            await client.pane_send_text(pane_ref, "/exit")
            await client.pane_submit_enter(pane_ref)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[stop-cli] /exit send skipped: %s", exc)
        deadline = time.monotonic() + STOP_WAIT_SECONDS
        while time.monotonic() < deadline:
            await asyncio.sleep(1.0)
            try:
                agent = await client.agent_get(pane_ref)
            except Exception:  # noqa: BLE001
                closed_cooperatively = True
                break
            if agent_status_of(agent) == AGENT_STATUS_DONE:
                closed_cooperatively = True
                break
        try:
            await client.pane_close(pane_ref)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[stop-cli] pane.close skipped: %s", exc)
        return {"ok": True, "closedCooperatively": closed_cooperatively}
    finally:
        await client.close()
