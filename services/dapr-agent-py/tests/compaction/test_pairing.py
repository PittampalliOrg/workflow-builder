"""Pairing-safe tail selection."""
from __future__ import annotations

from src.compaction.pairing import select_preserved_tail


def _u(text):  # user
    return {"role": "user", "content": text}


def _a(text, tool_calls=None):  # assistant
    msg = {"role": "assistant", "content": text}
    if tool_calls:
        msg["tool_calls"] = [{"id": tid} for tid in tool_calls]
    return msg


def _t(tid, text):  # tool result
    return {"role": "tool", "tool_call_id": tid, "content": text}


def test_preserves_simple_tail():
    msgs = [_u("u1"), _a("a1"), _u("u2"), _a("a2")]
    tail = select_preserved_tail(msgs, 2)
    assert [m["role"] for m in tail] == ["user", "assistant"]
    assert tail[0]["content"] == "u2"


def test_extends_backward_to_include_assistant_producing_tool_result():
    # Tail of 2 = [tool-1, tool-2] would orphan both; algorithm must extend
    # backward to include the assistant that called t1 and t2.
    msgs = [
        _u("u0"),
        _a("a0"),
        _u("u1"),
        _a("thinking", tool_calls=["t1", "t2"]),
        _t("t1", "result 1"),
        _t("t2", "result 2"),
    ]
    tail = select_preserved_tail(msgs, 2)
    # Must include the assistant with both tool calls AND both tool results.
    roles = [m["role"] for m in tail]
    assert "assistant" in roles
    assert roles.count("tool") == 2


def test_drops_assistant_whose_tool_results_are_missing():
    # Slice starts mid-stream; assistant inside the slice has a tool_call
    # whose result is outside the slice. We must drop the assistant to keep
    # pair invariant.
    msgs = [
        _a("outer", tool_calls=["x"]),
        _t("x", "outer_result"),
        _a("inner", tool_calls=["y"]),  # preserved slice starts here
        _u("follow-up"),
        # missing: tool result for "y"
    ]
    # Ask for last 2 = [assistant(inner), user(follow-up)]. Since y has no
    # matching result, assistant(inner) must be dropped.
    tail = select_preserved_tail(msgs, 2)
    # No assistant with unmatched tool_calls should remain.
    for m in tail:
        if m["role"] == "assistant":
            assert not m.get("tool_calls")


def test_does_not_cross_compact_boundary_backward():
    # If a compact boundary exists earlier, we must not extend backward past it.
    msgs = [
        {"role": "user", "content": "__COMPACT_BOUNDARY__ {\"turn_index\": 0}"},
        {"role": "user", "content": "<compact_summary>prior</compact_summary>"},
        _a("new assistant", tool_calls=["z"]),
        _t("z", "z_result"),
    ]
    tail = select_preserved_tail(msgs, 2)
    # Should include the new assistant+tool pair, not the boundary/summary.
    assert len(tail) == 2
    assert tail[0]["role"] == "assistant"
    assert tail[1]["role"] == "tool"


def test_old_system_boundary_still_stops_backward_walk():
    msgs = [
        {"role": "system", "content": "__COMPACT_BOUNDARY__ {\"turn_index\": 0}"},
        {"role": "user", "content": "<compact_summary>prior</compact_summary>"},
        _a("new assistant", tool_calls=["z"]),
        _t("z", "z_result"),
    ]
    tail = select_preserved_tail(msgs, 2)
    assert len(tail) == 2
    assert tail[0]["role"] == "assistant"


def test_empty_and_zero_n():
    assert select_preserved_tail([], 5) == []
    assert select_preserved_tail([_u("hi")], 0) == []
