from __future__ import annotations

import os
import sys

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

from src.session_host_monitor import (
    benchmark_activity_is_recent,
    benchmark_activity_marker,
    decide_missing_workflow_action,
    normalize_nonterminal_timeout_action,
    terminal_hold_seconds_for_status,
    workflow_progress_marker,
)


def test_missing_workflow_waits_during_grace_window() -> None:
    decision = decide_missing_workflow_action(
        first_seen_at=None,
        missing_since=None,
        now=100.0,
        missing_grace_seconds=60,
    )

    assert decision.missing_since == 100.0
    assert decision.exit_code is None


def test_unobserved_workflow_waits_for_start_timeout_owner() -> None:
    decision = decide_missing_workflow_action(
        first_seen_at=None,
        missing_since=100.0,
        now=161.0,
        missing_grace_seconds=60,
    )

    assert decision.missing_since == 100.0
    assert decision.exit_code is None


def test_observed_workflow_disappearing_exits_cleanly() -> None:
    decision = decide_missing_workflow_action(
        first_seen_at=90.0,
        missing_since=100.0,
        now=161.0,
        missing_grace_seconds=60,
    )

    assert decision.missing_since == 100.0
    assert decision.exit_code == 0


def test_terminal_hold_applies_only_to_completed_workflows() -> None:
    assert terminal_hold_seconds_for_status("COMPLETED", 1800) == 1800
    assert terminal_hold_seconds_for_status("FAILED", 1800) == 0
    assert terminal_hold_seconds_for_status("TERMINATED", 1800) == 0
    assert terminal_hold_seconds_for_status("COMPLETED", -1) == 0


def test_nonterminal_timeout_action_defaults_to_warn() -> None:
    assert normalize_nonterminal_timeout_action(None) == "warn"
    assert normalize_nonterminal_timeout_action("") == "warn"
    assert normalize_nonterminal_timeout_action("warn") == "warn"
    assert normalize_nonterminal_timeout_action("unexpected") == "warn"


def test_nonterminal_timeout_action_accepts_terminate_aliases() -> None:
    assert normalize_nonterminal_timeout_action("terminate") == "terminate"
    assert normalize_nonterminal_timeout_action("TERMINATE") == "terminate"
    assert normalize_nonterminal_timeout_action("exit") == "terminate"
    assert normalize_nonterminal_timeout_action("fail") == "terminate"


def test_workflow_progress_marker_reads_dapr_status_timestamps() -> None:
    assert (
        workflow_progress_marker({"lastUpdatedAt": "2026-05-25T05:39:41Z"})
        == "2026-05-25T05:39:41Z"
    )
    assert workflow_progress_marker({"last_updated_at": "  t2  "}) == "t2"
    assert workflow_progress_marker({"updatedAt": 123}) == "123"
    assert workflow_progress_marker({"customStatus": {"step": "tool"}}) == "{'step': 'tool'}"
    assert workflow_progress_marker({"runtimeStatus": "RUNNING"}) is None


def test_benchmark_activity_marker_reads_internal_progress_marker() -> None:
    assert benchmark_activity_marker({"progressMarker": "  event:42  "}) == "event:42"
    assert benchmark_activity_marker({"activityAgeSeconds": 10}) is None


def test_benchmark_activity_is_recent_uses_activity_age() -> None:
    assert benchmark_activity_is_recent(
        {"activityAgeSeconds": 899},
        idle_timeout_seconds=900,
    )
    assert not benchmark_activity_is_recent(
        {"activityAgeSeconds": 901},
        idle_timeout_seconds=900,
    )
    assert not benchmark_activity_is_recent(
        {"activityAgeSeconds": "bad"},
        idle_timeout_seconds=900,
    )
