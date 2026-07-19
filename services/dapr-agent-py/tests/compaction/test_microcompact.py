"""Microcompact — large tool-result trimming."""
from __future__ import annotations

from src.compaction.microcompact import _MICROCOMPACT_MARKER, microcompact_messages


def _tool(name, content):
    return {"role": "tool", "name": name, "content": content}


def test_trims_large_bash_result():
    msgs = [_tool("Bash", "x" * 5000)]
    out, saved = microcompact_messages(msgs, threshold_chars=2000, keep_last_n=0)
    assert len(out) == 1
    assert _MICROCOMPACT_MARKER in out[0]["content"]
    assert saved > 0


def test_keeps_last_n_tool_results_untouched():
    msgs = [
        _tool("Bash", "x" * 5000),
        _tool("Bash", "y" * 5000),
        _tool("Bash", "z" * 5000),  # last N=1 — should stay
    ]
    out, _ = microcompact_messages(msgs, threshold_chars=2000, keep_last_n=1)
    # First two trimmed, last one intact.
    assert _MICROCOMPACT_MARKER in out[0]["content"]
    assert _MICROCOMPACT_MARKER in out[1]["content"]
    assert _MICROCOMPACT_MARKER not in out[2]["content"]
    assert len(out[2]["content"]) == 5000


def test_ignores_non_compactable_tools():
    msgs = [_tool("SomeCustomTool", "x" * 5000)]
    out, saved = microcompact_messages(msgs, threshold_chars=2000, keep_last_n=0)
    assert _MICROCOMPACT_MARKER not in out[0]["content"]
    assert saved == 0


def test_kimi_formula_results_are_never_microcompacted():
    # Kimi formula tools (fetch, quickjs, excel, ...) can return encrypted
    # blobs that must round-trip byte-for-byte into the next chat request.
    # Their names stay outside _COMPACTABLE_TOOLS, so microcompaction must
    # never clear them — pin that invariant.
    msgs = [
        _tool("fetch", "x" * 5000),
        _tool("Bash", "y" * 5000),
        _tool("quickjs", "z" * 5000),
    ]
    out, saved = microcompact_messages(msgs, threshold_chars=2000, keep_last_n=0)
    assert out[0]["content"] == "x" * 5000
    assert out[2]["content"] == "z" * 5000
    assert _MICROCOMPACT_MARKER in out[1]["content"]
    assert saved > 0


def test_idempotent_on_already_trimmed():
    msgs = [_tool("Bash", "x" * 5000)]
    once, _ = microcompact_messages(msgs, threshold_chars=2000, keep_last_n=0)
    twice, _ = microcompact_messages(once, threshold_chars=2000, keep_last_n=0)
    assert once == twice


def test_leaves_short_content_alone():
    msgs = [_tool("Bash", "hi")]
    out, saved = microcompact_messages(msgs, threshold_chars=2000, keep_last_n=0)
    assert out[0]["content"] == "hi"
    assert saved == 0
