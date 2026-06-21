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
import urllib.error
import urllib.request
from typing import Any, Mapping

from src.capability_compiler.normalize import (
    normalize_transport,
    runtime_reachable_mcp_url,
    should_qualify_mcp_url,
)
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

# MCP warm-up bounds: scale-to-zero Activepieces piece MCP servers (Knative
# ap-<piece>-service) are warmed BEFORE the Claude Code TUI connects them once at
# launch (see _warm_ap_mcp_servers). Generous total deadline — a first-ever
# scale-up may pull the image — but always best-effort (never blocks launch).
CLI_MCP_WARM_TIMEOUT_SECONDS = float(
    os.environ.get("CLI_MCP_WARM_TIMEOUT_SECONDS", "40")
)
CLI_MCP_WARM_PER_REQUEST_TIMEOUT_SECONDS = float(
    os.environ.get("CLI_MCP_WARM_PER_REQUEST_TIMEOUT_SECONDS", "8")
)
CLI_MCP_WARM_RETRY_INTERVAL_SECONDS = float(
    os.environ.get("CLI_MCP_WARM_RETRY_INTERVAL_SECONDS", "2")
)


def _record(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _clean(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _sandbox_root() -> str:
    # Launch the CLI pane IN the per-execution shared workspace when one is
    # mounted (CLI_SHARED_WORKSPACE_MOUNT, set by sandbox-execution-api), so a
    # relative write lands in the shared workspace (/sandbox/work) instead of one
    # level up (/sandbox). Without this, codex's first relative apply_patch wrote
    # above the workspace and the model had to self-correct. Non-shared (pod-local)
    # sessions fall back to the sandbox root. Only the LAUNCH cwd uses this; config/
    # transcript/relay paths stay anchored at AGENT_LOCAL_SANDBOX_ROOT.
    return (
        os.environ.get("CLI_SHARED_WORKSPACE_MOUNT")
        or os.environ.get("AGENT_LOCAL_SANDBOX_ROOT", "/sandbox")
    )


# ---------------------------------------------------------------------------
# MCP warm-up (pre-launch)
# ---------------------------------------------------------------------------


def _warmable_mcp_urls(agent_config: Mapping[str, Any]) -> list[str]:
    """Reachable URLs of scale-to-zero Activepieces piece MCP servers in the
    agent config — the same FQDNs ``emit_claude_code_cli_servers`` wrote into
    ``mcp.json``. Skips stdio/websocket entries (no warmable URL) and the
    always-on shared Deployments (mcp-gateway / workflow-mcp-server), which never
    scale to zero."""
    servers = agent_config.get("mcpServers")
    if not isinstance(servers, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in servers:
        if not isinstance(item, Mapping):
            continue
        if not should_qualify_mcp_url(item):
            continue
        if normalize_transport(item) in {"stdio", "websocket"}:
            continue
        raw = item.get("url") or item.get("serverUrl")
        if not raw:
            continue
        url = runtime_reachable_mcp_url(item, str(raw))
        # Only per-piece scale-to-zero Knative services (ap-<piece>-service) need
        # warming; the always-on Deployments resolve to other hosts.
        if "ap-" not in url or "-service" not in url:
            continue
        if url not in seen:
            seen.add(url)
            out.append(url)
    return out


def _probe_mcp_url(url: str) -> bool:
    """GET ``url``; ANY HTTP response (incl. 4xx/405/406 from a StreamableHTTP
    endpoint rejecting a bare GET) means the pod is UP. A Knative activator 503,
    connection refused, or a timeout means still cold."""
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(
            req, timeout=CLI_MCP_WARM_PER_REQUEST_TIMEOUT_SECONDS
        ) as resp:
            return 200 <= int(resp.status) < 600
    except urllib.error.HTTPError as exc:
        return int(exc.code) != 503
    except Exception:  # noqa: BLE001
        return False


async def _warm_one_mcp_url(url: str, deadline: float) -> bool:
    loop = asyncio.get_event_loop()
    while time.monotonic() < deadline:
        if await loop.run_in_executor(None, _probe_mcp_url, url):
            return True
        await asyncio.sleep(CLI_MCP_WARM_RETRY_INTERVAL_SECONDS)
    return False


async def _warm_ap_mcp_servers(agent_config: Mapping[str, Any]) -> None:
    """Best-effort: warm (scale-from-zero) each Activepieces piece MCP server
    BEFORE the TUI launches and connects it ONCE at startup. A cold/scaling
    server otherwise fails that connect and the CLI mis-surfaces it as "not
    authenticated" with a dead-end browser Authenticate flow. Never raises — on
    timeout we log and proceed to launch (the per-connection Reconnect UI is the
    user-facing recovery for the residual race)."""
    urls = _warmable_mcp_urls(agent_config)
    if not urls:
        return
    logger.info(
        "[start-cli] warming %d Activepieces MCP server(s) before launch: %s",
        len(urls),
        ", ".join(urls),
    )
    deadline = time.monotonic() + CLI_MCP_WARM_TIMEOUT_SECONDS
    try:
        results = await asyncio.gather(
            *(_warm_one_mcp_url(u, deadline) for u in urls),
            return_exceptions=True,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[start-cli] MCP warm-up errored (continuing): %s", exc)
        return
    for url, ready in zip(urls, results):
        if ready is not True:
            logger.warning(
                "[start-cli] MCP server still cold after %.0fs (continuing): %s",
                CLI_MCP_WARM_TIMEOUT_SECONDS,
                url,
            )


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

    # Warm scale-to-zero Activepieces piece MCP servers before the TUI launches
    # and connects them once — see _warm_ap_mcp_servers.
    await _warm_ap_mcp_servers(agent_config)

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
            # Adapter background work (e.g. agy's ~/.gemini login-bundle capture
            # watcher). Best-effort; must not break session start.
            try:
                adapter.on_session_started(session_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[start-cli] on_session_started failed: %s", exc)
            # The zero-width INJECTION_MARKER is only meaningful for runtimes
            # whose events come from a Claude-style UserPromptSubmit hook (it
            # dedups self-injections). codex/agy mirror from native state and
            # codex's ratatui composer eats the marker + the first word — so
            # omit it for them. Set on the supervisor ONCE per session so BOTH
            # the kickoff (below) and later raise-event injections agree.
            from src.hooks_api import INJECTION_MARKER

            supervisor.injection_marker = (
                INJECTION_MARKER if adapter.uses_injection_marker else ""
            )
            # Adapters herdr only screen-detects (agy) gate readiness on their
            # rendered idle-prompt instead of herdr's premature `idle`.
            supervisor.prompt_ready_marker = adapter.prompt_ready_marker
            supervisor.prompt_not_ready_markers = adapter.prompt_not_ready_markers
            supervisor.hook_reports_prompt_submit = adapter.hook_reports_prompt_submit
            supervisor.idle_after_submit_is_success = (
                adapter.idle_after_submit_is_success
            )
            supervisor.trust_idle_ready_fallback = adapter.trust_idle_ready_fallback
            supervisor.composer_draft_markers = adapter.composer_draft_markers
            supervisor.emits_prompt_submit_hook = adapter.emits_prompt_submit_hook
            supervisor.onboarding_accept_markers = adapter.onboarding_accept_markers
            # Kickoff: type the seed prompt into the TUI once it reaches its
            # prompt (readiness-gated, scheduled onto the app loop — this
            # activity runs on a throwaway worker-thread loop). Skipped for
            # adapters that require an interactive in-pane login first (agy
            # device-code OAuth) — the seed must never land in the auth prompt.
            seed_text = _clean(input_data.get("seedUserMessage"))
            if seed_text and not adapter.requires_interactive_login:
                supervisor.arm_seed(
                    adapter.format_seed_user_message(seed_text),
                    marker=supervisor.injection_marker,
                )
            elif seed_text and adapter.requires_interactive_login:
                logger.info(
                    "[start-cli] adapter=%s requires interactive login — "
                    "deferring kickoff to the user (post-auth)",
                    adapter.name,
                )
        # R1 browser recording: if this agent uses the Playwright MCP, begin
        # recording via the supervisor-managed @playwright/mcp HTTP server (the
        # agent + this call share one context). browser_stop_video flushes the
        # .webm at finalize (browser_video_sync). Best-effort; never fails start.
        if _session_uses_playwright(agent_config):
            try:
                from src.playwright_mcp_client import browser_start_video

                ok = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: browser_start_video({"width": 1280, "height": 720})
                )
                logger.info("[start-cli] browser_start_video ok=%s", ok)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[start-cli] browser_start_video failed: %s", exc)
        return {"paneRef": pane_ref, "argv": argv, "agentDetected": agent_detected}
    finally:
        await client.close()


def _session_uses_playwright(agent_config: Mapping[str, Any]) -> bool:
    """True if the agent's MCP config references the Playwright server (so R1
    video recording applies)."""
    servers = agent_config.get("mcpServers")
    if not isinstance(servers, list):
        return False
    for s in servers:
        if not isinstance(s, Mapping):
            continue
        name = str(s.get("name") or s.get("server_name") or "").lower()
        url = str(s.get("url") or s.get("serverUrl") or "").lower()
        if name == "playwright" or "playwright" in url or ":3100" in url:
            return True
    return False


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
        # `done` is the TUI idling at its prompt after a turn — NOT an exit. A
        # real exit makes agent.get raise (→ pane_gone, terminal above); don't
        # reap a live idle session on the out-of-band liveness probe. Genuine
        # termination flows through pane_exit / cli.session_end / explicit stop /
        # the idle-TTL reaper. (wfb #133 — matches commit_state's done→idle.)
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
