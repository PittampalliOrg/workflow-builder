"""Counters mirroring `claude-code-src/main/bootstrap/state.ts:initMetrics`.

TS creates 8 counters; the Python port honors the 6 that apply to this
harness (PR / commit counters are skipped — the durable agent doesn't own
those surfaces). Every `.add()` merges the common telemetry attributes.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from .attributes import get_telemetry_attributes
from .providers import get_meter

logger = logging.getLogger(__name__)

_counters: dict[str, Any] = {}


def _get_counter(name: str, description: str, unit: str = ""):
    if name in _counters:
        return _counters[name]
    meter = get_meter()
    if meter is None:
        return None
    counter = meter.create_counter(name=name, description=description, unit=unit)
    _counters[name] = counter
    return counter


def _add(name: str, value: float, attributes: dict[str, Any] | None = None) -> None:
    counter = _counters.get(name)
    if counter is None:
        return
    merged = dict(get_telemetry_attributes())
    if attributes:
        for k, v in attributes.items():
            if v is None:
                continue
            merged[k] = v
    try:
        counter.add(value, merged)
    except Exception as exc:  # noqa: BLE001
        logger.warning("counter %s add failed: %s", name, exc)


def init_metrics() -> None:
    """Materialize counters. Called after `init_telemetry()`."""
    _get_counter(
        "claude_code.session.count",
        "Count of durable-agent sessions started",
    )
    _get_counter(
        "claude_code.lines_of_code.count",
        "Count of lines of code modified (type=added|removed)",
    )
    _get_counter(
        "claude_code.cost.usage",
        "Estimated cost of the Claude Code session",
        unit="USD",
    )
    _get_counter(
        "claude_code.token.usage",
        "Number of tokens used (type=input|output|cacheRead|cacheCreation)",
        unit="tokens",
    )
    _get_counter(
        "claude_code.code_edit_tool.decision",
        "Count of Edit/Write/NotebookEdit permission decisions (decision=accept|reject)",
    )
    _get_counter(
        "claude_code.active_time.total",
        "Total active time",
        unit="s",
    )


def record_session_start() -> None:
    _add("claude_code.session.count", 1)


def record_tokens(
    *,
    type_: str,
    count: int,
    model: str = "",
    speed: str = "normal",
) -> None:
    if count <= 0:
        return
    _add(
        "claude_code.token.usage",
        count,
        {"type": type_, "model": model, "speed": speed},
    )


def record_cost(
    *,
    cost_usd: float,
    model: str = "",
    speed: str = "normal",
) -> None:
    if cost_usd <= 0:
        return
    _add(
        "claude_code.cost.usage",
        cost_usd,
        {"model": model, "speed": speed},
    )


def record_code_edit_decision(*, decision: str, tool: str) -> None:
    _add(
        "claude_code.code_edit_tool.decision",
        1,
        {"decision": decision, "tool": tool},
    )


def record_lines_of_code(*, type_: str, count: int) -> None:
    if count <= 0:
        return
    _add("claude_code.lines_of_code.count", count, {"type": type_})


def record_active_time(seconds: float) -> None:
    if seconds <= 0:
        return
    _add("claude_code.active_time.total", seconds)


class ActiveTimeTimer:
    """Context manager that records the elapsed wall time to active_time.total."""

    def __enter__(self) -> "ActiveTimeTimer":
        self._start = time.monotonic()
        return self

    def __exit__(self, *_exc: Any) -> None:
        record_active_time(time.monotonic() - self._start)
