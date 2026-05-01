from __future__ import annotations

import importlib
import os
import sys

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

adapter = importlib.import_module("src.anthropic_adapter")
ib = importlib.import_module("src.instruction_bundle")


def _build_with_boundary(prefix_chars: int, dynamic: str = "Tail content.") -> str:
    """Return a string shaped exactly like the bundle's rendered.system."""
    static = "S" * prefix_chars
    return f"{static}\n\n{ib.SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n{dynamic}"


def test_build_system_param_returns_none_for_empty():
    out, tel = adapter._build_system_param(None)
    assert out is None
    assert tel["cache_eligible"] is False
    assert tel["cache_breakpoints"] == 0


def test_build_system_param_returns_string_when_no_boundary():
    out, tel = adapter._build_system_param("Just a plain system prompt.")
    assert isinstance(out, str)
    assert tel["cache_eligible"] is False
    assert tel["cache_breakpoints"] == 0
    assert tel["prefix_chars"] == 0
    assert tel["tail_chars"] == len("Just a plain system prompt.")


def test_build_system_param_below_threshold_strips_boundary_and_skips_cache():
    s = _build_with_boundary(prefix_chars=100, dynamic="dyn")
    out, tel = adapter._build_system_param(s)
    assert isinstance(out, str)
    assert ib.SYSTEM_PROMPT_DYNAMIC_BOUNDARY not in out
    assert "dyn" in out
    assert tel["cache_eligible"] is False
    assert tel["cache_breakpoints"] == 0
    assert tel["prefix_chars"] == 100
    assert tel["tail_chars"] == 3


def test_build_system_param_above_threshold_returns_text_blocks_with_cache_control():
    threshold = adapter.SYSTEM_PROMPT_CACHE_THRESHOLD_CHARS
    s = _build_with_boundary(prefix_chars=threshold + 10, dynamic="dynamic part")
    out, tel = adapter._build_system_param(s)
    assert isinstance(out, list)
    assert len(out) == 2
    assert out[0]["type"] == "text"
    assert out[0]["cache_control"] == {"type": "ephemeral"}
    assert out[0]["text"].startswith("S")
    assert out[1]["type"] == "text"
    assert "cache_control" not in out[1]
    assert out[1]["text"] == "dynamic part"
    assert tel["cache_eligible"] is True
    assert tel["cache_breakpoints"] == 1


def test_build_system_param_above_threshold_no_dynamic_emits_single_block():
    threshold = adapter.SYSTEM_PROMPT_CACHE_THRESHOLD_CHARS
    static = "S" * (threshold + 10)
    s = f"{static}\n\n{ib.SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n"
    out, tel = adapter._build_system_param(s)
    assert isinstance(out, list)
    assert len(out) == 1
    assert out[0]["cache_control"] == {"type": "ephemeral"}
    assert tel["cache_breakpoints"] == 1
    assert tel["cache_eligible"] is True


def test_build_system_param_passes_through_caller_supplied_list():
    caller_blocks = [
        {"type": "text", "text": "static", "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "dynamic"},
    ]
    out, tel = adapter._build_system_param(caller_blocks)
    assert out is caller_blocks
    assert tel["cache_breakpoints"] == 1


def test_first_boundary_split_wins_against_double_sentinel():
    threshold = adapter.SYSTEM_PROMPT_CACHE_THRESHOLD_CHARS
    static = "S" * (threshold + 10)
    s = (
        f"{static}\n\n{ib.SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n"
        f"middle\n\n{ib.SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\nend"
    )
    out, _ = adapter._build_system_param(s)
    assert isinstance(out, list)
    # Static prefix is what came before the FIRST boundary.
    assert out[0]["text"] == static
    # Dynamic tail carries everything after the first boundary, sentinel-and-all.
    assert "middle" in out[1]["text"]
    assert ib.SYSTEM_PROMPT_DYNAMIC_BOUNDARY in out[1]["text"]


def test_convert_tools_for_anthropic_sorts_by_name():
    tools = [
        {"name": "zebra", "input_schema": {}},
        {"name": "apple", "input_schema": {}},
        {"name": "mango", "input_schema": {}},
    ]
    out = adapter._convert_tools_for_anthropic(tools)
    assert [t["name"] for t in out] == ["apple", "mango", "zebra"]


def test_convert_tools_for_anthropic_handles_empty_or_none():
    assert adapter._convert_tools_for_anthropic(None) is None
    assert adapter._convert_tools_for_anthropic([]) is None
