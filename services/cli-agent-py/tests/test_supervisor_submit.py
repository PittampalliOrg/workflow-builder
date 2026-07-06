"""Submit-confirmation tests for the agy composer-draft disambiguation.

agy reports `idle` after Enter for BOTH a genuinely fast turn AND a dropped
Enter (prompt stranded in the composer). The supervisor disambiguates via the
``composer_draft_markers`` substring on the visible pane: draft present → the
Enter was dropped → re-press; composer clear → accept.
"""

from __future__ import annotations

import asyncio
import time

import pytest

import src.session_supervisor as sup
from src.session_supervisor import SessionSupervisor


class _FakeClient:
    def __init__(self, statuses: list[str], pane_texts: list[str]):
        self._statuses = list(statuses)
        self._pane_texts = list(pane_texts)
        self.enter_presses = 0

    async def agent_get(self, pane, **_kw):
        status = self._statuses.pop(0) if self._statuses else "idle"
        return {"agent_status": status}

    async def pane_read(self, pane, *, source="visible"):
        text = self._pane_texts.pop(0) if self._pane_texts else ""
        return {"read": {"text": text}}

    async def pane_submit_enter(self, pane):
        self.enter_presses += 1
        return {}


def _supervisor(client) -> SessionSupervisor:
    s = SessionSupervisor(client=client, disabled=False)
    s.idle_after_submit_is_success = True
    s.composer_draft_markers = ("more lines",)
    return s


@pytest.fixture(autouse=True)
def _fast_submit(monkeypatch):
    # Don't sleep through the real 2s verify window in tests.
    monkeypatch.setattr(sup, "CLI_SUBMIT_VERIFY_SECONDS", 0.0)
    monkeypatch.setattr(sup, "CLI_SUBMIT_RETRIES", 3)


def test_idle_with_draft_repressed_until_working():
    # idle + draft on first sample → re-press; then the turn starts (working).
    client = _FakeClient(
        statuses=["idle", "working"],
        pane_texts=["> the prompt\n↑ 33 more lines\n? for shortcuts"],
    )
    s = _supervisor(client)
    assert asyncio.run(s._confirm_submitted("pane-1")) is True
    assert client.enter_presses == 1  # exactly one re-press landed the submit


def test_idle_without_draft_accepted_as_fast_turn():
    # idle + EMPTY composer → a genuinely fast turn already returned; accept,
    # never re-press into an empty composer.
    client = _FakeClient(
        statuses=["idle"],
        pane_texts=["assistant reply done\n? for shortcuts"],
    )
    s = _supervisor(client)
    assert asyncio.run(s._confirm_submitted("pane-1")) is True
    assert client.enter_presses == 0


def test_idle_with_persistent_draft_fails():
    # Draft never clears across all retries → submit genuinely failed.
    client = _FakeClient(
        statuses=["idle", "idle", "idle", "idle"],
        pane_texts=["↑ 33 more lines"] * 4,
    )
    s = _supervisor(client)
    assert asyncio.run(s._confirm_submitted("pane-1")) is False


class _AckClient:
    """Fake herdr client whose Enter press fires the CLI's UserPromptSubmit hook
    (via the supervisor ack) on the Nth press — modelling codex/claude accepting
    the prompt once their composer is actually ready."""

    def __init__(self, supervisor, ack_on_press: int):
        self._sup = supervisor
        self._ack_on_press = ack_on_press
        self.enter_presses = 0

    async def pane_submit_enter(self, pane):
        self.enter_presses += 1
        if self._ack_on_press and self.enter_presses >= self._ack_on_press:
            self._sup.note_prompt_submit_ack()
        return {}


@pytest.fixture
def _fast_ack(monkeypatch):
    monkeypatch.setattr(sup, "CLI_SUBMIT_ACK_WAIT_SECONDS", 0.05)
    monkeypatch.setattr(sup, "CLI_READY_POLL_SECONDS", 0.01)
    monkeypatch.setattr(sup, "CLI_SUBMIT_RETRIES", 5)


def test_hook_ack_after_one_repress(_fast_ack):
    s = SessionSupervisor(client=None, disabled=False)
    s.emits_prompt_submit_hook = True
    client = _AckClient(s, ack_on_press=1)
    s._client = client
    # No ack yet → first poll window fails → one Enter re-press fires the hook ack.
    assert asyncio.run(s._await_hook_submit_ack("pane-1", 0)) is True
    assert client.enter_presses == 1


def test_hook_ack_never_arrives_fails_bounded(_fast_ack):
    s = SessionSupervisor(client=None, disabled=False)
    s.emits_prompt_submit_hook = True
    client = _AckClient(s, ack_on_press=0)  # hook never fires
    s._client = client
    # Bounded: CLI_SUBMIT_RETRIES re-presses, then give up (prompt left in composer).
    assert asyncio.run(s._await_hook_submit_ack("pane-1", 0)) is False
    assert client.enter_presses == 5


def test_hook_ack_already_present_no_repress(_fast_ack):
    s = SessionSupervisor(client=None, disabled=False)
    s.emits_prompt_submit_hook = True
    client = _AckClient(s, ack_on_press=999)
    s._client = client
    # Hook fired during the first poll window (the initial Enter already landed) →
    # accept without any re-press.
    s.note_prompt_submit_ack()
    assert asyncio.run(s._await_hook_submit_ack("pane-1", 0)) is True
    assert client.enter_presses == 0


class _OnboardClient:
    def __init__(self, pane_text: str):
        self._text = pane_text
        self.enter_presses = 0

    async def pane_read(self, pane, *, source="visible"):
        return {"read": {"text": self._text}}

    async def pane_submit_enter(self, pane):
        self.enter_presses += 1
        return {}


def test_onboarding_trust_prompt_auto_accepted():
    client = _OnboardClient(
        "You are in /sandbox\nDo you trust the contents of this directory?\n"
        "1. Yes, continue\n2. No, quit"
    )
    s = SessionSupervisor(client=client, disabled=False)
    s.onboarding_accept_markers = ("do you trust the contents of this directory",)
    assert asyncio.run(s._maybe_accept_onboarding("pane-1")) is True
    assert client.enter_presses == 1  # Enter = highlighted "Yes, continue"


def test_onboarding_no_dialog_no_press():
    client = _OnboardClient("gpt-5.5 default · /sandbox")  # ordinary idle composer
    s = SessionSupervisor(client=client, disabled=False)
    s.onboarding_accept_markers = ("do you trust the contents of this directory",)
    assert asyncio.run(s._maybe_accept_onboarding("pane-1")) is False
    assert client.enter_presses == 0


# ---------------------------------------------------------------------------
# Idle-reaper select→reconfirm TOCTOU guard (W3b)
# ---------------------------------------------------------------------------


class _ReapClient:
    def __init__(self):
        self.exit_sends: list[str] = []
        self.enter_presses = 0

    async def pane_send_text(self, pane, text):
        self.exit_sends.append(text)
        return {}

    async def pane_submit_enter(self, pane):
        self.enter_presses += 1
        return {}

    async def agent_get(self, pane, **_kw):
        return {"agent_status": "done"}


def _reap_ready_supervisor(client) -> SessionSupervisor:
    """A supervisor whose live state makes _should_reap() True (idle past TTL, no
    attached clients), wired with a no-op lifecycle raise."""
    s = SessionSupervisor(
        client=client, raise_lifecycle=lambda *_a, **_k: None, disabled=False
    )
    s._pane_ref = "pane-1"
    s._instance_id = "inst-1"
    s._committed_state = sup.AGENT_STATUS_IDLE
    s._idle_since = time.monotonic() - sup.CLI_IDLE_TTL_SECONDS - 10
    s._attach_count = 0
    s._last_terminal_activity = 0.0
    return s


def test_idle_reap_proceeds_when_still_idle(monkeypatch):
    monkeypatch.setattr(sup, "CLI_GRACEFUL_EXIT_WAIT_SECONDS", 0.0)
    client = _ReapClient()
    s = _reap_ready_supervisor(client)
    asyncio.run(s.request_graceful_exit(reason="idle_timeout"))
    assert client.exit_sends == ["/exit"]
    assert client.enter_presses == 1
    assert s._reaping is True
    assert s._exit_raised is True


def test_idle_reap_aborts_when_client_attaches_between_select_and_act(monkeypatch):
    monkeypatch.setattr(sup, "CLI_GRACEFUL_EXIT_WAIT_SECONDS", 0.0)
    client = _ReapClient()
    s = _reap_ready_supervisor(client)
    s._attach_count = 1  # a client attached after the reaper decided to reap
    asyncio.run(s.request_graceful_exit(reason="idle_timeout"))
    assert client.exit_sends == []  # /exit never sent
    assert s._reaping is False
    assert s._exit_raised is False  # session left alive


def test_idle_reap_aborts_when_turn_starts_between_select_and_act(monkeypatch):
    monkeypatch.setattr(sup, "CLI_GRACEFUL_EXIT_WAIT_SECONDS", 0.0)
    client = _ReapClient()
    s = _reap_ready_supervisor(client)
    s._committed_state = sup.AGENT_STATUS_WORKING  # a new turn started
    asyncio.run(s.request_graceful_exit(reason="idle_timeout"))
    assert client.exit_sends == []
    assert s._reaping is False
    assert s._exit_raised is False


def test_inject_refused_while_reaping():
    client = _ReapClient()
    s = SessionSupervisor(
        client=client, raise_lifecycle=lambda *_a, **_k: None, disabled=False
    )
    s._pane_ref = "pane-1"
    s._reaping = True
    ok = asyncio.run(s.inject_user_text("hello there", await_ready=False))
    assert ok is False
    assert client.exit_sends == []  # never typed into the exiting session


def test_send_to_pane_refused_under_lock_when_reaping():
    """Primary TOCTOU guard: even if inject_user_text's entry check passed before
    the reaper set _reaping, the under-lock recheck in _send_to_pane refuses — so
    an injection that was QUEUED on the pane-write lock while the reaper committed
    never types into the exiting session."""
    client = _ReapClient()
    s = SessionSupervisor(
        client=client, raise_lifecycle=lambda *_a, **_k: None, disabled=False
    )
    s._pane_ref = "pane-1"
    s._reaping = True  # reaper committed under the lock we're about to take
    ok = asyncio.run(s._send_to_pane("hello there", "", source="injection"))
    assert ok is False
    assert client.exit_sends == []  # no pane_send_text — nothing typed


def test_reaper_defers_while_injection_pending():
    """Belt-and-suspenders: a pending injection (counted in _pending_injections)
    makes _should_reap() return False, so the reaper's under-lock recheck defers
    instead of racing an injection that hasn't reached the pane-write lock yet."""
    client = _ReapClient()
    s = _reap_ready_supervisor(client)
    assert s._should_reap() is True  # baseline: reapable
    s._pending_injections = 1
    assert s._should_reap() is False  # deferred by the in-flight injection
    asyncio.run(s.request_graceful_exit(reason="idle_timeout"))
    assert client.exit_sends == []  # aborted under the lock — no /exit
    assert s._reaping is False
    assert s._exit_raised is False


def test_inject_user_text_counts_pending_and_clears_after():
    """inject_user_text bumps _pending_injections for the whole attempt and clears
    it in a finally, so a completed injection leaves the reaper reapable again."""
    client = _ReapClient()
    s = SessionSupervisor(
        client=client, raise_lifecycle=lambda *_a, **_k: None, disabled=False
    )
    s._pane_ref = "pane-1"
    s._seed_complete = True  # skip the seed-first wait

    async def _fake_send(text, marker, *, source):
        # Assert the counter is held DURING the send, then succeed.
        assert s._pending_injections == 1
        return True

    s._send_to_pane = _fake_send  # type: ignore[assignment]
    ok = asyncio.run(s.inject_user_text("hi", await_ready=False))
    assert ok is True
    assert s._pending_injections == 0  # cleared in the finally
