"""Submit-confirmation tests for the agy composer-draft disambiguation.

agy reports `idle` after Enter for BOTH a genuinely fast turn AND a dropped
Enter (prompt stranded in the composer). The supervisor disambiguates via the
``composer_draft_markers`` substring on the visible pane: draft present → the
Enter was dropped → re-press; composer clear → accept.
"""

from __future__ import annotations

import asyncio

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
