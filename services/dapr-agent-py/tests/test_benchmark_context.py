from __future__ import annotations

import os
import sys


root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

from src.benchmark_context import is_swebench_execution_context  # noqa: E402


def test_swebench_context_matches_instance_id() -> None:
    assert is_swebench_execution_context(
        "sw-swebench-instance-exec-abc__durable__solve__run__0",
        {},
    )


def test_swebench_context_matches_session_or_execution_id() -> None:
    assert is_swebench_execution_context(
        "agent-session-abc:turn-1",
        {
            "sessionId": "sw-swebench-instance-exec-parent__durable__solve__run__0",
            "executionId": "not-used",
        },
    )


def test_swebench_context_does_not_match_interactive_sessions() -> None:
    assert not is_swebench_execution_context(
        "agent-session-abc:turn-1",
        {"sessionId": "sesn_interactive", "executionId": "wf_123"},
    )
