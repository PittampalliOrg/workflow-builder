"""Tests for run_tool idempotency (plan 1c).

Proves a replayed (instance_id, tool_call_id) returns the cached result WITHOUT
re-executing the side effect, plus instance isolation, the durable-scan tier,
the soft cap, and that failures / empty ids are never cached.
"""
from __future__ import annotations

import os
import sys

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

from src.tool_idempotency import (
    ToolResultCache,
    find_recorded_tool_result,
    tool_idempotency_enabled,
)


def test_replayed_tool_call_id_returns_cached_without_reexecuting():
    cache = ToolResultCache()
    side_effects = {"count": 0}

    def producer():
        side_effects["count"] += 1
        return {"role": "tool", "tool_call_id": "tc-1", "content": f"effect #{side_effects['count']}"}

    r1, hit1 = cache.remember("inst-1", "tc-1", producer)
    r2, hit2 = cache.remember("inst-1", "tc-1", producer)

    # Side effect ran exactly once; the replay returned the cached result.
    assert side_effects["count"] == 1
    assert hit1 is False
    assert hit2 is True
    assert r2 == r1
    assert r2["content"] == "effect #1"


def test_distinct_tool_call_id_reexecutes():
    cache = ToolResultCache()
    n = {"count": 0}

    def producer():
        n["count"] += 1
        return {"content": n["count"]}

    cache.remember("inst-1", "tc-1", producer)
    _, hit = cache.remember("inst-1", "tc-2", producer)
    assert n["count"] == 2
    assert hit is False


def test_instance_isolation():
    cache = ToolResultCache()
    n = {"count": 0}

    def producer():
        n["count"] += 1
        return {"content": n["count"]}

    cache.remember("inst-A", "tc-1", producer)
    _, hit = cache.remember("inst-B", "tc-1", producer)
    # Same tool_call_id, different instance -> not a hit; re-executes.
    assert n["count"] == 2
    assert hit is False


def test_empty_tool_call_id_is_never_cached():
    cache = ToolResultCache()
    n = {"count": 0}

    def producer():
        n["count"] += 1
        return {"content": n["count"]}

    cache.remember("inst-1", "", producer)
    cache.remember("inst-1", "", producer)
    assert n["count"] == 2  # never short-circuited
    assert len(cache) == 0
    assert cache.get("inst-1", "") is None
    assert cache.has("inst-1", "") is False


def test_clear_instance_drops_only_that_instance():
    cache = ToolResultCache()
    cache.put("inst-1", "tc-1", {"x": 1})
    cache.put("inst-1", "tc-2", {"x": 2})
    cache.put("inst-2", "tc-1", {"x": 3})
    dropped = cache.clear_instance("inst-1")
    assert dropped == 2
    assert cache.get("inst-1", "tc-1") is None
    assert cache.get("inst-2", "tc-1") == {"x": 3}


def test_soft_cap_evicts_oldest():
    cache = ToolResultCache(max_entries=3)
    for i in range(5):
        cache.put("inst-1", f"tc-{i}", {"i": i})
    assert len(cache) == 3
    # Oldest two evicted; newest three retained.
    assert cache.get("inst-1", "tc-0") is None
    assert cache.get("inst-1", "tc-1") is None
    assert cache.get("inst-1", "tc-4") == {"i": 4}


def test_find_recorded_tool_result_durable_scan_dict():
    messages = [
        {"role": "user", "content": "do it"},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "tc-9"}]},
        {"role": "tool", "tool_call_id": "tc-9", "content": "DONE", "name": "bash"},
        {"role": "user", "content": "next"},
    ]
    found = find_recorded_tool_result(messages, "tc-9")
    assert found is not None
    assert found["content"] == "DONE"
    assert find_recorded_tool_result(messages, "tc-absent") is None
    assert find_recorded_tool_result(messages, "") is None


def test_find_recorded_tool_result_object_messages():
    class _Msg:
        def __init__(self, role, tool_call_id=None, content=None, name=None):
            self.role = role
            self.tool_call_id = tool_call_id
            self.content = content
            self.name = name

    messages = [
        _Msg("user", content="hi"),
        _Msg("tool", tool_call_id="tc-7", content="RESULT", name="edit"),
    ]
    found = find_recorded_tool_result(messages, "tc-7")
    assert found is not None
    assert found["content"] == "RESULT"
    assert found["tool_call_id"] == "tc-7"


def test_enabled_by_default_and_env_toggle(monkeypatch):
    monkeypatch.delenv("DAPR_AGENT_PY_TOOL_IDEMPOTENCY_ENABLED", raising=False)
    assert tool_idempotency_enabled() is True
    monkeypatch.setenv("DAPR_AGENT_PY_TOOL_IDEMPOTENCY_ENABLED", "false")
    assert tool_idempotency_enabled() is False
    monkeypatch.setenv("DAPR_AGENT_PY_TOOL_IDEMPOTENCY_ENABLED", "1")
    assert tool_idempotency_enabled() is True
