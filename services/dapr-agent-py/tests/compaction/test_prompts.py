"""Summarization prompt parity + format_compact_summary."""
from __future__ import annotations

from src.compaction.prompts import (
    BASE_COMPACT_PROMPT,
    NO_TOOLS_PREAMBLE,
    NO_TOOLS_TRAILER,
    format_compact_summary,
    get_compact_prompt,
)


def test_get_compact_prompt_default():
    prompt = get_compact_prompt()
    assert prompt.startswith(NO_TOOLS_PREAMBLE)
    assert BASE_COMPACT_PROMPT in prompt
    assert prompt.endswith(NO_TOOLS_TRAILER)


def test_get_compact_prompt_custom_instructions():
    prompt = get_compact_prompt("Focus on python edits")
    assert "Additional Instructions:" in prompt
    assert "Focus on python edits" in prompt
    # Custom instructions must appear BEFORE the trailer (mirrors TS ordering).
    assert prompt.index("Additional Instructions") < prompt.index(NO_TOOLS_TRAILER.strip()[:20])


def test_format_compact_summary_strips_analysis_and_extracts_summary():
    raw = (
        "<analysis>\n"
        "drafting... thinking about concepts... files...\n"
        "</analysis>\n\n"
        "<summary>\n"
        "1. Primary Request\n"
        "   - user wants X\n"
        "2. Files\n"
        "   - foo.py\n"
        "</summary>\n"
    )
    out = format_compact_summary(raw)
    assert "<analysis>" not in out
    assert "<summary>" not in out
    assert out.startswith("Summary:")
    assert "Primary Request" in out
    assert "foo.py" in out


def test_format_compact_summary_missing_tags_returns_trimmed_raw():
    raw = "   just some text without tags   "
    out = format_compact_summary(raw)
    assert out == "just some text without tags"


def test_format_compact_summary_collapses_repeated_blank_lines():
    raw = "<summary>\nA\n\n\n\nB\n</summary>"
    out = format_compact_summary(raw)
    assert "\n\n\n" not in out
