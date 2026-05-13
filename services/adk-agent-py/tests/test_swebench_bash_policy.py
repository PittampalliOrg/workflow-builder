from __future__ import annotations

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.swebench_bash_policy import swebench_bash_policy_violation

SWEBENCH_SESSION = "sw-swebench-instance-exec-abc__durable__solve__run__0"


def test_swebench_blocks_dependency_install():
    result = swebench_bash_policy_violation("pip install -e .", SWEBENCH_SESSION)

    assert "SWE-bench policy blocks this command" in result
    assert "installing or reinstalling dependencies" in result


def test_swebench_blocks_environment_rewrite():
    result = swebench_bash_policy_violation(
        "sed -i 's|/testbed|/sandbox/repo|g' "
        "/sandbox/.venv/lib/python3.9/site-packages/finder.py",
        SWEBENCH_SESSION,
    )

    assert "SWE-bench policy blocks this command" in result
    assert "rewriting the benchmark Python environment" in result


def test_swebench_allows_source_inspection():
    result = swebench_bash_policy_violation(
        "python - <<'PY'\nprint('ok')\nPY",
        SWEBENCH_SESSION,
    )

    assert result is None


def test_non_swebench_session_does_not_apply_policy():
    result = swebench_bash_policy_violation("pip install -e .", "session-abc")

    assert result is None
