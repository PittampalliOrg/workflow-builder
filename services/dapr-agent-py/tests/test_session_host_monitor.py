from __future__ import annotations

import os
import sys

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

from src.session_host_monitor import decide_missing_workflow_action


def test_missing_workflow_waits_during_grace_window() -> None:
    decision = decide_missing_workflow_action(
        first_seen_at=None,
        missing_since=None,
        now=100.0,
        missing_grace_seconds=60,
    )

    assert decision.missing_since == 100.0
    assert decision.exit_code is None


def test_missing_workflow_exits_after_grace_window() -> None:
    decision = decide_missing_workflow_action(
        first_seen_at=None,
        missing_since=100.0,
        now=161.0,
        missing_grace_seconds=60,
    )

    assert decision.missing_since == 100.0
    assert decision.exit_code == 1


def test_observed_workflow_disappearing_exits_cleanly() -> None:
    decision = decide_missing_workflow_action(
        first_seen_at=90.0,
        missing_since=None,
        now=100.0,
        missing_grace_seconds=60,
    )

    assert decision.missing_since == 100.0
    assert decision.exit_code == 0
