"""SessionSupervisor — owns the headless herdr server child process, mirrors
herdr's semantic agent state into CMA session events, and idle-reaps abandoned
TUI sessions.

Responsibilities (per the interactive-cli runtime design):
  (a) spawn ``herdr server`` at app start (env HERDR_SOCKET_PATH); restart with
      backoff if it dies; skipped entirely when HERDR_DISABLE=1 (unit tests).
  (b) consume ``events.subscribe`` and map the registered claude pane's agent
      state → session events:
        working → session.status_running
        idle    → session.status_idle {stop_reason: "end_turn"}
        blocked → session.status_idle {blocked: true, reason: permission_prompt|auth|awaiting_input}
        done / pane exit → raise Dapr external event {type: "cli.exited", exitCode}
      onto the session's workflow instance (the WORKFLOW publishes
      session.status_terminated, not the supervisor).
  (c) idle reaping: idle continuously > CLI_IDLE_TTL_SECONDS with no terminal
      client attached → graceful '/exit' + Enter, bounded wait, then raise
      {type: "cli.exited", reason: "idle_timeout"}.

State flapping is debounced (CLI_STATE_DEBOUNCE_SECONDS, default 2s).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Callable, Mapping

from src.event_publisher import publish_session_event
from src.herdr_client import (
    AGENT_STATUS_BLOCKED,
    AGENT_STATUS_DONE,
    AGENT_STATUS_IDLE,
    AGENT_STATUS_WORKING,
    DEFAULT_GLOBAL_SUBSCRIPTIONS,
    HerdrClient,
    agent_status_of,
    agent_status_subscription,
    pane_id_of,
    status_detail_of,
)
from src.taskhub import raise_lifecycle_events

logger = logging.getLogger(__name__)


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


HERDR_DISABLED = _env_bool("HERDR_DISABLE", False)
CLI_IDLE_TTL_SECONDS = _env_float("CLI_IDLE_TTL_SECONDS", 3600.0)
CLI_STATE_DEBOUNCE_SECONDS = _env_float("CLI_STATE_DEBOUNCE_SECONDS", 2.0)
CLI_IDLE_REAP_POLL_SECONDS = _env_float("CLI_IDLE_REAP_POLL_SECONDS", 30.0)
CLI_GRACEFUL_EXIT_WAIT_SECONDS = _env_float("CLI_GRACEFUL_EXIT_WAIT_SECONDS", 30.0)
# Readiness gate for typing into the TUI. The pane must be registered AND the
# Claude Code TUI must have finished booting to its prompt (herdr reports the
# agent `idle`) before keystrokes land — injecting during boot loses them.
# The seed (kickoff) waits longer because it fires right after pane launch;
# mid-session injections (goal-loop continuations, chat) ride a shorter gate
# since the TUI is already at its prompt. Both fall back to a best-effort send
# on timeout rather than dropping the message.
CLI_SEED_READY_TIMEOUT = _env_float("CLI_SEED_READY_TIMEOUT_SECONDS", 60.0)
CLI_INJECT_READY_TIMEOUT = _env_float("CLI_INJECT_READY_TIMEOUT_SECONDS", 20.0)
CLI_READY_POLL_SECONDS = _env_float("CLI_READY_POLL_SECONDS", 0.5)
# Submit reliability: the Claude Code Ink TUI ingests typed text via bracketed
# paste, so an Enter sent immediately after `pane.send_text` races the paste and
# is dropped — the prompt sits unsubmitted (verified live on dev 2026-06-10).
# Settle before pressing Enter, then VERIFY the agent left `idle`; if it didn't,
# the Enter never registered — re-press it. A real turn never completes within
# the verify window, so "still idle" reliably means not-submitted (no risk of
# submitting an empty prompt).
CLI_SUBMIT_DELAY_SECONDS = _env_float("CLI_SUBMIT_DELAY_SECONDS", 0.6)
CLI_SUBMIT_VERIFY_SECONDS = _env_float("CLI_SUBMIT_VERIFY_SECONDS", 1.5)
CLI_SUBMIT_RETRIES = int(_env_float("CLI_SUBMIT_RETRIES", 2))
HERDR_SERVER_ARGV = ["herdr", "server"]


def classify_blocked_reason(detail: str | None) -> str:
    """Map herdr's explain/detail string to a coarse blocked reason."""
    text = (detail or "").lower()
    if "permission" in text or "approve" in text or "allow" in text:
        return "permission_prompt"
    if "auth" in text or "login" in text or "token" in text or "credential" in text:
        return "auth"
    return "awaiting_input"


def _looks_like_pane_exit(event_type: str) -> bool:
    text = event_type.lower()
    return "closed" in text or "exited" in text or "exit" in text


class SessionSupervisor:
    def __init__(
        self,
        *,
        client: HerdrClient | None = None,
        publish: Callable[..., None] = publish_session_event,
        raise_lifecycle: Callable[[str, list[dict[str, Any]]], None] = raise_lifecycle_events,
        disabled: bool | None = None,
    ):
        self._disabled = HERDR_DISABLED if disabled is None else disabled
        self._client = client or HerdrClient()
        self._publish = publish
        self._raise_lifecycle = raise_lifecycle
        self._proc: asyncio.subprocess.Process | None = None
        self._tasks: list[asyncio.Task] = []
        self._stopping = False
        # The FastAPI app loop, captured in start(); seed injection is scheduled
        # onto it from the start_cli activity's throwaway worker-thread loop.
        self._loop: asyncio.AbstractEventLoop | None = None

        # Single-session registry (one CLI session per sandbox pod).
        self._session_id: str | None = None
        self._instance_id: str | None = None
        self._pane_ref: str | None = None
        self._transcript_path: str | None = None

        # Zero-width prefix stamped on injected prompts so a Claude-style
        # UserPromptSubmit hook can dedup self-injections. Set per-session in
        # _start_cli from the adapter (hooks_api.INJECTION_MARKER for claude-code;
        # "" for codex/agy, whose composers/event-mirrors don't use it). The
        # literal default matches hooks_api.INJECTION_MARKER (inlined to avoid the
        # hooks_api -> session_supervisor import cycle); it is always overwritten
        # at session start, so it is only a fallback.
        self.injection_marker: str = "\u200b\u2060\u200b"  # = hooks_api.INJECTION_MARKER
        # When set (adapter.prompt_ready_marker, e.g. agy's "? for shortcuts"), the
        # readiness gate waits for this substring on the VISIBLE screen instead of
        # herdr's (screen-detected, unreliable) agent_status.
        self.prompt_ready_marker: str | None = None
        self._cli_session_id: str | None = None

        # Semantic-state tracking.
        self._committed_state: str | None = None
        self._idle_since: float | None = None
        self._debounce_task: asyncio.Task | None = None
        self._exit_raised = False

        # Kickoff (seed) injection — armed once by start_cli, injected once the
        # readiness gate clears. `_seed_pending` is set synchronously by
        # arm_seed (worker thread); `_seed_injected` is the exactly-once claim
        # (set in _inject_seed's prologue); `_seed_complete` is set AFTER the
        # send so mid-session injections can order themselves after the kickoff.
        self._seed_task: Any = None  # concurrent.futures.Future
        self._seed_pending = False
        self._seed_injected = False
        self._seed_complete = False
        # Serializes every write to the TUI pane (send_text + Enter pair) so the
        # seed and any concurrent injection never interleave their keystrokes.
        # Created lazily on the app loop (Lock binds to the running loop).
        self._pane_write_lock: asyncio.Lock | None = None

        # Terminal-attachment tracking (idle-reap "no clients" signal).
        # herdr does not document a queryable client count, so we track our own
        # WS attach/detach + last-activity timestamps in-process.
        self._attach_count = 0
        self._last_terminal_activity = 0.0

    # -- lifecycle -----------------------------------------------------------

    @property
    def disabled(self) -> bool:
        return self._disabled

    async def start(self) -> None:
        # Capture the app loop unconditionally so arm_seed works even with herdr
        # disabled in tests (it short-circuits there).
        self._loop = asyncio.get_running_loop()
        if self._disabled:
            logger.info("[supervisor] HERDR_DISABLE set — skipping herdr server")
            return
        self._stopping = False
        self._tasks.append(asyncio.ensure_future(self._run_server_loop()))
        self._tasks.append(asyncio.ensure_future(self._event_loop()))
        self._tasks.append(asyncio.ensure_future(self._idle_reaper()))

    async def stop(self) -> None:
        self._stopping = True
        for task in self._tasks:
            task.cancel()
        self._tasks = []
        if self._seed_task is not None:
            try:
                self._seed_task.cancel()
            except Exception:  # noqa: BLE001
                pass
            self._seed_task = None
        if self._proc is not None and self._proc.returncode is None:
            try:
                self._proc.terminate()
            except ProcessLookupError:
                pass
        self._proc = None
        await self._client.close()

    async def _run_server_loop(self) -> None:
        backoff = 1.0
        socket_path = self._client.socket_path
        os.makedirs(os.path.dirname(socket_path) or "/tmp", exist_ok=True)
        while not self._stopping:
            try:
                env = dict(os.environ)
                env["HERDR_SOCKET_PATH"] = socket_path
                self._proc = await asyncio.create_subprocess_exec(
                    *HERDR_SERVER_ARGV, env=env
                )
                logger.info(
                    "[supervisor] herdr server started (pid=%s, socket=%s)",
                    self._proc.pid,
                    socket_path,
                )
                backoff = 1.0
                code = await self._proc.wait()
                if self._stopping:
                    return
                logger.warning("[supervisor] herdr server exited with code %s", code)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("[supervisor] herdr server spawn failed: %s", exc)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)

    async def ping(self, timeout: float = 2.0) -> bool:
        if self._disabled:
            return True
        try:
            await self._client.ping(timeout=timeout)
            return True
        except Exception:  # noqa: BLE001
            return False

    # -- session registry ------------------------------------------------------

    def register_session(
        self, *, session_id: str | None, instance_id: str | None, pane_ref: str | None
    ) -> None:
        self._session_id = session_id
        self._instance_id = instance_id
        self._pane_ref = pane_ref
        self._exit_raised = False
        self._idle_since = None
        logger.info(
            "[supervisor] registered session=%s instance=%s pane=%s",
            session_id,
            instance_id,
            pane_ref,
        )

    def register_transcript(
        self, transcript_path: str | None, cli_session_id: str | None
    ) -> None:
        if transcript_path:
            self._transcript_path = transcript_path
        if cli_session_id:
            self._cli_session_id = cli_session_id

    def get_session(self) -> dict[str, Any]:
        return {
            "sessionId": self._session_id,
            "instanceId": self._instance_id,
            "paneRef": self._pane_ref,
            "transcriptPath": self._transcript_path,
            "cliSessionId": self._cli_session_id,
        }

    def get_pane_ref(self) -> str | None:
        return self._pane_ref

    # -- terminal attachment signals -----------------------------------------

    def note_terminal_attached(self) -> None:
        self._attach_count += 1
        self._last_terminal_activity = time.monotonic()

    def note_terminal_detached(self) -> None:
        self._attach_count = max(0, self._attach_count - 1)
        self._last_terminal_activity = time.monotonic()

    def note_terminal_activity(self) -> None:
        self._last_terminal_activity = time.monotonic()

    @property
    def attached_clients(self) -> int:
        return self._attach_count

    # -- event consumption -----------------------------------------------------

    async def _event_loop(self) -> None:
        backoff = 1.0
        while not self._stopping:
            # `pane.agent_status_changed` is PANE-SCOPED (no wildcard), so the
            # stream is (re)built with the registered pane and torn down when
            # the registration changes — the reconnect picks up the new pane.
            pane_for_stream = self._pane_ref
            subscriptions = [dict(s) for s in DEFAULT_GLOBAL_SUBSCRIPTIONS]
            if pane_for_stream:
                subscriptions.append(agent_status_subscription(pane_for_stream))
            stream = self._client.subscribe_events(subscriptions)
            iterator = stream.__aiter__()
            try:
                while True:
                    # Per-event timeout so a quiet stream still notices that
                    # register_session() changed the pane (registration happens
                    # on an activity thread, not via a herdr event).
                    try:
                        event = await asyncio.wait_for(
                            iterator.__anext__(), timeout=15.0
                        )
                    except asyncio.TimeoutError:
                        if self._pane_ref != pane_for_stream:
                            break
                        continue
                    except StopAsyncIteration:
                        break
                    backoff = 1.0
                    self.handle_event(event)
                    if self._pane_ref != pane_for_stream:
                        break  # resubscribe with the newly registered pane
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.debug("[supervisor] event stream error: %s", exc)
            finally:
                try:
                    await stream.aclose()
                except Exception:  # noqa: BLE001
                    pass
            if self._pane_ref != pane_for_stream:
                continue  # immediate resubscribe, no backoff
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)

    def handle_event(self, event: Mapping[str, Any]) -> None:
        """Process one herdr event (also called directly by tests)."""
        event_type = str(event.get("type") or event.get("event") or "")
        pane = pane_id_of(event)
        # Only track the registered claude pane when we know it; if no pane is
        # registered yet, accept any agent-state event (single-pane pods).
        if self._pane_ref and pane and pane != self._pane_ref:
            return

        if event_type and _looks_like_pane_exit(event_type):
            # Exit is one-shot + destructive: only act on the REGISTERED pane
            # (the global pane.exited subscription also sees shell tabs and
            # pre-registration strays). Streamed name is `pane_exited` (sic).
            if not self._pane_ref or pane != self._pane_ref:
                return
            exit_code = pick_exit_code(event)
            self._raise_cli_exited(exit_code=exit_code, reason="pane_exit")
            return

        status = agent_status_of(event)
        if not status:
            return
        detail = status_detail_of(event)
        self._schedule_state_commit(status, detail)

    def _schedule_state_commit(self, status: str, detail: str | None) -> None:
        if self._debounce_task is not None and not self._debounce_task.done():
            self._debounce_task.cancel()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No loop (sync test context) — commit immediately.
            self.commit_state(status, detail)
            return
        self._debounce_task = loop.create_task(self._debounced_commit(status, detail))

    async def _debounced_commit(self, status: str, detail: str | None) -> None:
        try:
            await asyncio.sleep(CLI_STATE_DEBOUNCE_SECONDS)
        except asyncio.CancelledError:
            return
        self.commit_state(status, detail)

    def commit_state(self, status: str, detail: str | None = None) -> None:
        """Publish the debounced semantic state transition."""
        if status == self._committed_state and status != AGENT_STATUS_BLOCKED:
            return
        self._committed_state = status
        session_id = self._session_id
        if status == AGENT_STATUS_WORKING:
            self._idle_since = None
            if session_id:
                self._publish(session_id, "session.status_running", {})
        elif status == AGENT_STATUS_IDLE:
            if self._idle_since is None:
                self._idle_since = time.monotonic()
            if session_id:
                self._publish(
                    session_id, "session.status_idle", {"stop_reason": "end_turn"}
                )
        elif status == AGENT_STATUS_BLOCKED:
            self._idle_since = None
            if session_id:
                self._publish(
                    session_id,
                    "session.status_idle",
                    {"blocked": True, "reason": classify_blocked_reason(detail)},
                )
        elif status == AGENT_STATUS_DONE:
            self._idle_since = None
            self._raise_cli_exited(exit_code=0, reason="agent_done")

    def _raise_cli_exited(
        self, *, exit_code: int | None, reason: str | None = None
    ) -> None:
        """Raise {type: cli.exited} onto the workflow — exactly once.

        The lifecycle WORKFLOW emits session.status_terminated; the supervisor
        only signals."""
        if self._exit_raised:
            return
        instance_id = self._instance_id
        if not instance_id:
            return
        self._exit_raised = True
        event: dict[str, Any] = {"type": "cli.exited"}
        if exit_code is not None:
            event["exitCode"] = exit_code
        if reason:
            event["reason"] = reason
        self._dispatch_lifecycle(instance_id, [event])

    def _dispatch_lifecycle(self, instance_id: str, events: list[dict[str, Any]]) -> None:
        def _send() -> None:
            try:
                self._raise_lifecycle(instance_id, events)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[supervisor] raise lifecycle events failed for %s: %s",
                    instance_id,
                    exc,
                )

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            _send()
            return
        # taskhub gRPC is blocking — keep it off the event loop.
        loop.run_in_executor(None, _send)

    # -- idle reaping ------------------------------------------------------------

    async def _idle_reaper(self) -> None:
        while not self._stopping:
            await asyncio.sleep(CLI_IDLE_REAP_POLL_SECONDS)
            try:
                if self._should_reap():
                    logger.info(
                        "[supervisor] idle TTL exceeded (%.0fs, no clients) — reaping",
                        CLI_IDLE_TTL_SECONDS,
                    )
                    await self.request_graceful_exit(reason="idle_timeout")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("[supervisor] idle reap pass failed: %s", exc)

    def _should_reap(self) -> bool:
        if self._exit_raised or self._committed_state != AGENT_STATUS_IDLE:
            return False
        if self._idle_since is None:
            return False
        if self._attach_count > 0:
            return False
        now = time.monotonic()
        if now - self._idle_since < CLI_IDLE_TTL_SECONDS:
            return False
        # A recently-active (even if now-closed) terminal also defers the reap.
        if (
            self._last_terminal_activity
            and now - self._last_terminal_activity < CLI_IDLE_TTL_SECONDS
        ):
            return False
        return True

    async def request_graceful_exit(self, *, reason: str) -> None:
        """Cooperatively end the TUI: '/exit' + Enter, bounded wait, then signal."""
        pane = self._pane_ref
        if pane and not self._disabled:
            try:
                await self._client.pane_send_text(pane, "/exit")
                await self._client.pane_submit_enter(pane)
            except Exception as exc:  # noqa: BLE001
                logger.debug("[supervisor] graceful /exit send failed: %s", exc)
            deadline = time.monotonic() + CLI_GRACEFUL_EXIT_WAIT_SECONDS
            while time.monotonic() < deadline and not self._exit_raised:
                await asyncio.sleep(1.0)
                try:
                    result = await self._client.agent_get(pane)
                except Exception:  # noqa: BLE001
                    break  # pane/agent gone — treat as exited
                if agent_status_of(result) == AGENT_STATUS_DONE:
                    break
        self._raise_cli_exited(exit_code=None, reason=reason)

    # -- readiness gate ----------------------------------------------------------

    async def wait_until_ready(self, timeout: float) -> bool:
        """Block until the TUI is ready to accept typed input: the pane is
        registered AND Claude Code has booted to its prompt (herdr reports the
        agent ``idle``). Returns True when ready, False on timeout. Injecting
        before this gate clears loses the keystrokes into the boot screen.

        The live ``agent.get`` poll is AUTHORITATIVE; the (≈2s-debounced)
        committed state is only a fallback for when herdr is unreachable. This
        ordering closes the window where a just-sent message left the agent
        ``working`` but the committed state still reads a stale ``idle``."""
        if self._disabled:
            return True
        deadline = time.monotonic() + max(0.0, timeout)
        while time.monotonic() < deadline:
            pane = self._pane_ref
            if pane:
                if self.prompt_ready_marker:
                    # Content-gated: herdr screen-detects this TUI and reports
                    # `idle` before the composer exists, so trust the rendered
                    # prompt instead (the marker is absent on the boot screen AND
                    # while a turn is in flight → also correct for mid-session).
                    if await self._prompt_rendered(pane):
                        return True
                else:
                    try:
                        info = await self._client.agent_get(pane)
                        if agent_status_of(info) == AGENT_STATUS_IDLE:
                            return True
                    except Exception:  # noqa: BLE001
                        # herdr unreachable / pane not registered yet — fall back
                        # to the event-stream's committed state.
                        if self._committed_state == AGENT_STATUS_IDLE:
                            return True
            await asyncio.sleep(CLI_READY_POLL_SECONDS)
        return False

    async def _prompt_rendered(self, pane: str) -> bool:
        """True when ``prompt_ready_marker`` is on the pane's VISIBLE screen — i.e.
        the TUI's idle composer is actually drawn. Conservative: any read error
        returns False so the gate keeps waiting (then injects best-effort on
        timeout)."""
        marker = self.prompt_ready_marker
        if not marker:
            return True
        try:
            res = await self._client.pane_read(pane, source="visible")
        except Exception:  # noqa: BLE001
            return False
        read = res.get("read") if isinstance(res, Mapping) else None
        text = read.get("text", "") if isinstance(read, Mapping) else ""
        return marker in text

    async def _is_blocked_now(self) -> bool:
        """True when the TUI is sitting at a permission/auth dialog — NEVER type
        into it (Enter would mis-answer the prompt)."""
        if self._committed_state == AGENT_STATUS_BLOCKED:
            return True
        pane = self._pane_ref
        if pane:
            try:
                info = await self._client.agent_get(pane)
                return agent_status_of(info) == AGENT_STATUS_BLOCKED
            except Exception:  # noqa: BLE001
                pass
        return False

    async def _send_to_pane(self, text: str, marker: str) -> bool:
        pane = self._pane_ref
        if not pane:
            logger.warning("[supervisor] no registered pane to inject into")
            return False
        if self._pane_write_lock is None:
            self._pane_write_lock = asyncio.Lock()
        # Hold the lock across the text+Enter pair so two senders (seed vs a
        # concurrent injection) never interleave keystrokes on the pane.
        async with self._pane_write_lock:
            try:
                await self._client.pane_send_text(pane, f"{marker}{text}")
                # Let the TUI ingest the pasted text before pressing Enter, then
                # confirm the submit registered (re-press if the agent is still
                # idle — the Enter raced the paste and was dropped).
                await asyncio.sleep(CLI_SUBMIT_DELAY_SECONDS)
                await self._client.pane_submit_enter(pane)
                await self._confirm_submitted(pane)
                return True
            except Exception as exc:  # noqa: BLE001
                logger.warning("[supervisor] pane inject failed: %s", exc)
                return False

    async def _confirm_submitted(self, pane: str) -> None:
        """After Enter, the agent should leave ``idle`` (it starts the turn). If
        it is still idle after the verify window the keystroke was dropped — re-
        press Enter (bounded). A genuine turn never finishes this fast, so a
        persistent ``idle`` reliably means not-yet-submitted."""
        for _ in range(max(0, CLI_SUBMIT_RETRIES)):
            await asyncio.sleep(CLI_SUBMIT_VERIFY_SECONDS)
            try:
                info = await self._client.agent_get(pane)
            except Exception:  # noqa: BLE001
                return  # pane gone / unreachable — nothing more to do
            if agent_status_of(info) != AGENT_STATUS_IDLE:
                return  # working / blocked / done → the submit landed
            logger.info("[supervisor] submit not registered — re-pressing Enter")
            try:
                await self._client.pane_submit_enter(pane)
            except Exception:  # noqa: BLE001
                return

    async def _gated_send(self, text: str, marker: str, timeout: float, *, what: str) -> bool:
        """Wait for the TUI to be ready, then send — but REFUSE to type into a
        blocked (permission/auth) dialog even on gate timeout."""
        ready = await self.wait_until_ready(timeout)
        if not ready and await self._is_blocked_now():
            logger.warning(
                "[supervisor] %s refused — TUI is blocked (permission/auth "
                "dialog); not typing into it",
                what,
            )
            return False
        if not ready:
            logger.warning(
                "[supervisor] %s readiness gate timed out after %.0fs — "
                "injecting best-effort (TUI not blocked)",
                what,
                timeout,
            )
        return await self._send_to_pane(text, marker)

    # -- kickoff (seed) injection ------------------------------------------------

    def arm_seed(self, text: str, *, marker: str = "") -> None:
        """Schedule the kickoff message to be typed into the TUI once the
        readiness gate clears. Called from the start_cli activity's worker
        thread, so the coroutine is handed to the captured app loop. One-shot:
        re-arming (e.g. activity retry) is ignored, including while the first
        injection is still in flight."""
        clean = (text or "").strip()
        if not clean or self._seed_injected:
            return
        if self._seed_task is not None and not self._seed_task.done():
            return  # an injection coroutine is already scheduled/running
        loop = self._loop
        if loop is None:
            logger.warning("[supervisor] arm_seed before start(); seed dropped")
            return
        self._seed_pending = True  # gate mid-session injections behind the seed
        try:
            self._seed_task = asyncio.run_coroutine_threadsafe(
                self._inject_seed(clean, marker), loop
            )  # concurrent.futures.Future; fire-and-forget
        except RuntimeError as exc:  # loop closed during shutdown
            logger.debug("[supervisor] arm_seed could not schedule: %s", exc)
            self._seed_complete = True  # don't strand injections waiting on it

    async def _inject_seed(self, text: str, marker: str) -> None:
        if self._seed_injected:
            return
        self._seed_injected = True  # claim before awaiting — exactly-once
        try:
            injected = await self._gated_send(
                text, marker, CLI_SEED_READY_TIMEOUT, what="kickoff"
            )
            logger.info("[supervisor] kickoff injected=%s", injected)
        finally:
            # Unblock any mid-session injection waiting for the kickoff to land,
            # whether it succeeded, was refused, or errored.
            self._seed_complete = True

    async def _await_seed_first(self) -> None:
        """Block a mid-session injection until the kickoff has been typed (or
        the seed gave up), so the agent never processes a continuation before
        its kickoff. Bounded so a stuck seed can't wedge injections forever."""
        if not self._seed_pending or self._seed_complete:
            return
        deadline = time.monotonic() + CLI_SEED_READY_TIMEOUT + 5.0
        while not self._seed_complete and time.monotonic() < deadline:
            await asyncio.sleep(CLI_READY_POLL_SECONDS)

    # -- TUI text injection (raise-event user.message path) ----------------------

    async def inject_user_text(
        self, text: str, *, marker: str = "", await_ready: bool = True
    ) -> bool:
        """Type ``text`` into the claude pane + press Enter. Used by the
        raise-event endpoint for user.message (goal-loop continuations / chat
        bridge) — these do NOT enter the workflow.

        Ordering + safety: waits for the kickoff to land first (so the agent
        never processes a continuation before its seed), then gates on the TUI
        being at its prompt, and REFUSES to type into a blocked dialog. With
        ``await_ready`` False it still serializes behind the seed + pane-write
        lock but skips the readiness wait (callers that already know it is
        safe)."""
        if self._disabled:
            return False
        await self._await_seed_first()
        if not await_ready:
            return await self._send_to_pane(text, marker)
        return await self._gated_send(
            text, marker, CLI_INJECT_READY_TIMEOUT, what="injection"
        )


def pick_exit_code(event: Mapping[str, Any]) -> int | None:
    for key in ("exit_code", "exitCode", "code"):
        value = event.get(key)
        if isinstance(value, int):
            return value
    nested = event.get("data") or event.get("payload")
    if isinstance(nested, Mapping):
        return pick_exit_code(nested)
    return None


# Module-level singleton wired by main.py's lifespan; activities + the hooks
# receiver + the terminal WS route all reach the supervisor through this.
_supervisor: SessionSupervisor | None = None


def set_supervisor(supervisor: SessionSupervisor | None) -> None:
    global _supervisor
    _supervisor = supervisor


def get_supervisor() -> SessionSupervisor | None:
    return _supervisor
