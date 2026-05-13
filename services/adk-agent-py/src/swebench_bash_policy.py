from __future__ import annotations

import re

SWEBENCH_SESSION_PREFIX = "sw-swebench-"

_BLOCKED_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"(^|[;&|()\s])(?:python[0-9.]*\s+)?setup\.py\s+build_ext\b"),
        "building project extension modules",
    ),
    (
        re.compile(r"(^|[;&|()\s])(?:python[0-9.]*\s+-m\s+)?pip\s+install\b"),
        "installing or reinstalling dependencies",
    ),
    (
        re.compile(
            r"\b(?:sed|perl)\b(?=.*\s-i\b)(?=.*(?:/sandbox/\.venv|/testbed))",
        ),
        "rewriting the benchmark Python environment",
    ),
    (
        re.compile(r"\b(?:cp|mv|rm|chmod|chown)\b[^;&|]*(?:/sandbox/\.venv|/testbed)"),
        "mutating the benchmark Python environment",
    ),
)


def swebench_bash_policy_violation(command: str, session_id: str | None) -> str | None:
    if not (session_id or "").startswith(SWEBENCH_SESSION_PREFIX):
        return None

    normalized = " ".join(command.strip().split())
    for pattern, reason in _BLOCKED_PATTERNS:
        if pattern.search(normalized):
            return (
                "Error: SWE-bench policy blocks this command because it is "
                f"{reason}. Do not repair, reinstall, rebuild, or rewrite the "
                "benchmark environment. If local imports fail because compiled "
                "extensions or /testbed permissions are unavailable, stop "
                "debugging the environment and inspect/edit source files under "
                "/sandbox/repo instead. Leave the final repository patch applied "
                "and verify it with `git diff --stat`."
            )
    return None
