"""Unit tests for concurrency-safe tool batching (Claude Code partitionToolCalls port)."""

from __future__ import annotations

import importlib

tb = importlib.import_module("src.tool_batching")
safe = tb.tool_name_concurrency_safe
partition = tb.partition_tool_calls


def _tc(name):
    return {"id": f"id-{name}", "function": {"name": name, "arguments": "{}"}}


def _batchable(tc):
    return safe(tc["function"]["name"])


def _part(calls, cap=6):
    return partition(calls, is_batchable=_batchable, max_concurrency=cap)


# --- classifier ------------------------------------------------------------

def test_read_only_tools_safe():
    for n in ("Read", "Grep", "Glob", "LS", "NotebookRead", "read_file"):
        assert safe(n), n


def test_mutating_tools_unsafe():
    for n in ("Bash", "Write", "Edit", "MultiEdit", "", "RandomTool"):
        assert not safe(n), n


def test_mcp_read_prefixes_safe():
    assert safe("mcp__pg__list_tables")
    assert safe("mcp__gh__get_issue")
    assert safe("search_docs")
    assert not safe("mcp__gh__create_issue")


# --- partitioning ----------------------------------------------------------

def test_all_reads_one_parallel_batch():
    p = _part([_tc("Read"), _tc("Read"), _tc("Read")])
    assert len(p) == 1
    assert p[0]["parallel"] is True
    assert [i for i, _ in p[0]["items"]] == [0, 1, 2]


def test_unsafe_breaks_into_serial_segments():
    p = _part([_tc("Read"), _tc("Read"), _tc("Bash"), _tc("Read"), _tc("Read")])
    assert [(seg["parallel"], [i for i, _ in seg["items"]]) for seg in p] == [
        (True, [0, 1]),
        (False, [2]),
        (True, [3, 4]),
    ]


def test_single_safe_call_is_serial_not_parallel():
    p = _part([_tc("Read"), _tc("Bash")])
    assert p[0]["parallel"] is False  # lone Read normalized to serial
    assert p[1]["parallel"] is False


def test_concurrency_cap_splits_batches():
    p = _part([_tc("Read")] * 5, cap=2)
    # 2 + 2 + 1 ; the trailing lone item normalizes to serial
    assert [(seg["parallel"], len(seg["items"])) for seg in p] == [
        (True, 2),
        (True, 2),
        (False, 1),
    ]


def test_order_preserved_across_mixed():
    calls = [_tc("Bash"), _tc("Read"), _tc("Read"), _tc("Write"), _tc("Grep")]
    p = _part(calls)
    flat = [i for seg in p for i, _ in seg["items"]]
    assert flat == [0, 1, 2, 3, 4]


def test_non_batchable_callback_forces_serial():
    # Even read-only tools stay serial if the caller marks them non-batchable
    # (e.g. WorkflowContextInjectedTool / agent-call tools).
    p = partition(
        [_tc("Read"), _tc("Read")],
        is_batchable=lambda tc: False,
        max_concurrency=6,
    )
    assert all(not seg["parallel"] for seg in p)
    assert len(p) == 2
