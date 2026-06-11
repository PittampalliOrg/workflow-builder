"""Readiness gate for typing into the Claude Code TUI.

The kickoff (seed) prompt and mid-session injections must wait until the TUI has
booted to its prompt (herdr reports the agent `idle`) — injecting during boot
loses the keystrokes (the live failure that motivated this gate: the kickoff
raced the TUI and never landed, so the user had to re-type it).
"""

from __future__ import annotations

import asyncio

import pytest

import src.session_supervisor as ss
from src.session_supervisor import SessionSupervisor


class FakeHerdr:
    """Minimal async herdr client: scriptable agent_get + recorded sends."""

    def __init__(self, statuses=None, *, raise_until=0):
        # successive agent_get results (last value repeats)
        self._statuses = list(statuses or ["idle"])
        self._raise_until = raise_until
        self._calls = 0
        self.sent: list[str] = []
        self.enters = 0

    async def agent_get(self, target=None, **_kw):
        self._calls += 1
        if self._calls <= self._raise_until:
            raise RuntimeError("pane not registered yet")
        idx = min(self._calls - 1, len(self._statuses) - 1)
        return {"agent_status": self._statuses[idx]}

    async def pane_send_text(self, pane, text):
        self.sent.append(text)

    async def pane_submit_enter(self, pane):
        self.enters += 1

    async def close(self):
        pass


def _supervisor(client, **kw):
    sup = SessionSupervisor(
        client=client,
        publish=lambda *a, **k: None,
        raise_lifecycle=lambda *a, **k: None,
        disabled=False,
    )
    sup._loop = asyncio.get_event_loop()
    return sup


async def test_wait_until_ready_committed_state_is_only_a_fallback(monkeypatch):
    # agent.get is AUTHORITATIVE: a stale committed `idle` must NOT pass the
    # gate while the live agent is `working` (closes the 2s-debounce race).
    monkeypatch.setattr(ss, "CLI_READY_POLL_SECONDS", 0.01)
    sup = _supervisor(FakeHerdr(statuses=["working"]))
    sup._pane_ref = "p1"
    sup._committed_state = ss.AGENT_STATUS_IDLE
    assert await sup.wait_until_ready(0.05) is False


async def test_wait_until_ready_falls_back_to_committed_when_herdr_unreachable(monkeypatch):
    monkeypatch.setattr(ss, "CLI_READY_POLL_SECONDS", 0.01)
    # agent.get always raises → committed `idle` is the fallback ready signal.
    sup = _supervisor(FakeHerdr(statuses=["idle"], raise_until=10_000))
    sup._pane_ref = "p1"
    sup._committed_state = ss.AGENT_STATUS_IDLE
    assert await sup.wait_until_ready(0.2) is True


async def test_wait_until_ready_polls_agent_get_until_idle(monkeypatch):
    monkeypatch.setattr(ss, "CLI_READY_POLL_SECONDS", 0.01)
    client = FakeHerdr(statuses=["unknown", "unknown", "idle"])
    sup = _supervisor(client)
    sup._pane_ref = "p1"
    assert await sup.wait_until_ready(5.0) is True
    assert client._calls >= 3


async def test_wait_until_ready_times_out_when_never_idle(monkeypatch):
    monkeypatch.setattr(ss, "CLI_READY_POLL_SECONDS", 0.01)
    sup = _supervisor(FakeHerdr(statuses=["unknown"]))
    sup._pane_ref = "p1"
    assert await sup.wait_until_ready(0.05) is False


async def test_wait_until_ready_waits_for_pane_registration(monkeypatch):
    monkeypatch.setattr(ss, "CLI_READY_POLL_SECONDS", 0.01)
    sup = _supervisor(FakeHerdr(statuses=["idle"]))
    # no pane registered yet → never ready within the window
    assert await sup.wait_until_ready(0.05) is False


async def test_disabled_supervisor_is_always_ready():
    sup = SessionSupervisor(
        client=FakeHerdr(), publish=lambda *a, **k: None, disabled=True
    )
    assert await sup.wait_until_ready(0.0) is True


async def test_inject_seed_waits_then_sends_with_marker_once(monkeypatch):
    monkeypatch.setattr(ss, "CLI_READY_POLL_SECONDS", 0.01)
    client = FakeHerdr(statuses=["unknown", "idle"])
    sup = _supervisor(client)
    sup._pane_ref = "p1"
    await sup._inject_seed("hello there", marker="MK:")
    assert client.sent == ["MK:hello there"]
    assert client.enters == 1
    assert sup._seed_injected is True
    # second call is a no-op (exactly-once)
    await sup._inject_seed("hello there", marker="MK:")
    assert client.sent == ["MK:hello there"]


async def test_inject_seed_best_effort_send_on_timeout(monkeypatch):
    monkeypatch.setattr(ss, "CLI_READY_POLL_SECONDS", 0.01)
    monkeypatch.setattr(ss, "CLI_SEED_READY_TIMEOUT", 0.05)
    client = FakeHerdr(statuses=["unknown"])  # never idle
    sup = _supervisor(client)
    sup._pane_ref = "p1"
    await sup._inject_seed("kick", marker="")
    assert client.sent == ["kick"]  # still injected best-effort


async def test_inject_user_text_gates_on_readiness(monkeypatch):
    monkeypatch.setattr(ss, "CLI_READY_POLL_SECONDS", 0.01)
    client = FakeHerdr(statuses=["working", "working", "idle"])
    sup = _supervisor(client)
    sup._pane_ref = "p1"
    sup._committed_state = ss.AGENT_STATUS_WORKING  # mid-turn → must wait for idle
    ok = await sup.inject_user_text("continue", marker="", await_ready=True)
    assert ok is True
    assert client.sent == ["continue"]


async def test_arm_seed_is_one_shot(monkeypatch):
    sup = _supervisor(FakeHerdr())
    sup._seed_injected = True  # already done
    sup.arm_seed("late", marker="")
    assert sup._seed_task is None  # not scheduled


def test_extract_injectable_messages_handles_session_user_events_batch():
    from src.main import _extract_injectable_messages

    payload = {
        "events": [
            {"type": "user.message", "content": [{"type": "text", "text": "first"}]},
            {"type": "agent.message", "content": [{"type": "text", "text": "skip"}]},
            {"type": "user.message", "content": "second"},
        ]
    }
    assert _extract_injectable_messages("session.user_events", payload) == [
        "first",
        "second",
    ]


def test_extract_injectable_messages_handles_direct_user_message():
    from src.main import _extract_injectable_messages

    assert _extract_injectable_messages(
        "user.message", {"content": [{"type": "text", "text": "hi"}]}
    ) == ["hi"]


async def test_refuses_to_type_into_a_blocked_dialog(monkeypatch):
    """The readiness gate must NEVER type into a permission/auth dialog —
    pressing Enter there mis-answers a security-relevant prompt."""
    monkeypatch.setattr(ss, "CLI_READY_POLL_SECONDS", 0.01)
    client = FakeHerdr(statuses=["blocked"])
    sup = _supervisor(client)
    sup._pane_ref = "p1"
    sup._committed_state = ss.AGENT_STATUS_BLOCKED
    ok = await sup.inject_user_text("continue", marker="", await_ready=True)
    assert ok is False
    assert client.sent == []  # refused — nothing typed into the dialog


async def test_seed_best_effort_send_only_when_not_blocked(monkeypatch):
    monkeypatch.setattr(ss, "CLI_READY_POLL_SECONDS", 0.01)
    monkeypatch.setattr(ss, "CLI_SEED_READY_TIMEOUT", 0.05)
    # never idle but NOT blocked → best-effort send still fires
    client = FakeHerdr(statuses=["unknown"])
    sup = _supervisor(client)
    sup._pane_ref = "p1"
    await sup._inject_seed("kick", marker="")
    assert client.sent == ["kick"]
    assert sup._seed_complete is True


async def test_injection_waits_for_kickoff_to_land_first(monkeypatch):
    """A mid-session injection arriving during the seed window must be typed
    AFTER the kickoff (ordering), so the agent isn't driven before its seed."""
    monkeypatch.setattr(ss, "CLI_READY_POLL_SECONDS", 0.01)
    client = FakeHerdr(statuses=["idle"])
    sup = _supervisor(client)
    sup._pane_ref = "p1"
    sup._seed_pending = True  # seed armed, not yet complete

    async def _complete_seed_soon():
        await asyncio.sleep(0.05)
        await sup._inject_seed("KICKOFF", marker="")

    # injection starts first but must block until the seed completes
    seed_fut = asyncio.ensure_future(_complete_seed_soon())
    ok = await sup.inject_user_text("continuation", marker="", await_ready=True)
    await seed_fut
    assert ok is True
    assert client.sent == ["KICKOFF", "continuation"]  # kickoff first


async def test_pane_writes_are_serialized(monkeypatch):
    """Two concurrent senders must not interleave their text+Enter pairs."""
    order: list[str] = []

    class SlowHerdr(FakeHerdr):
        async def pane_send_text(self, pane, text):
            order.append(f"text:{text}")
            await asyncio.sleep(0.02)  # widen the interleave window

        async def pane_submit_enter(self, pane):
            order.append("enter")

    sup = _supervisor(SlowHerdr(statuses=["idle"]))
    sup._pane_ref = "p1"
    await asyncio.gather(
        sup._send_to_pane("A", ""),
        sup._send_to_pane("B", ""),
    )
    # each text is immediately followed by its own enter (no interleave)
    assert order in (
        ["text:A", "enter", "text:B", "enter"],
        ["text:B", "enter", "text:A", "enter"],
    )
