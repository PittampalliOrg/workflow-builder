"""Tests for the GLM/Z.AI adapter's output-mode selection — focused on the
Tier-2 structured-output path for dynamic-script agent(..., {schema}) on GLM:
force response_format=json_object while KEEPING thinking on (GLM has no strict
json_schema; the prompt <output-contract> conveys the shape, the journal
validates it, and thinking is preserved for verify/critic quality)."""
from __future__ import annotations

import importlib
import os
import sys

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

adapter = importlib.import_module("src.zai_adapter")


def test_native_json_schema_forces_json_object_keeping_thinking_on():
    body: dict = {}
    adapter._apply_zai_output_mode(body, structured=False, native_json_schema={"type": "object"})
    assert body["response_format"] == {"type": "json_object"}
    # thinking stays ENABLED (distinct from the memory-path structured mode)
    assert body["thinking"] == {"type": "enabled"}
    assert "reasoning_effort" in body


def test_no_native_schema_leaves_response_format_unset():
    body: dict = {}
    adapter._apply_zai_output_mode(body, structured=False)
    assert "response_format" not in body
    assert body["thinking"] == {"type": "enabled"}


def test_pydantic_structured_path_unchanged_disables_thinking():
    # The memory-summarization path (structured=True) returns early: thinking
    # off + json_object, and native_json_schema is ignored (precedence).
    body: dict = {}
    adapter._apply_zai_output_mode(body, structured=True, native_json_schema={"type": "object"})
    assert body["thinking"] == {"type": "disabled"}
    assert body["response_format"] == {"type": "json_object"}
    assert "reasoning_effort" not in body


def test_tool_chat_disables_thinking_and_ignores_native_schema():
    body: dict = {}
    adapter._apply_zai_output_mode(body, structured=False, tool_chat=True, native_json_schema={"type": "object"})
    assert body["thinking"] == {"type": "disabled"}
    assert "response_format" not in body
