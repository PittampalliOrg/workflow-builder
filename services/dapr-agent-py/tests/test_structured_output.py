"""Tests for the StructuredOutput tool mechanism (src/structured_output.py):
per-request tool definition, argument validation (in-loop retry contract), and
the deterministic success detection the durable loop uses to finalize."""
from __future__ import annotations

import json
import os
import sys

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

from src.structured_output import (  # noqa: E402
    STRUCTURED_OUTPUT_TOOL_NAME,
    evaluate_structured_output_call,
    schema_supports_structured_tool,
    structured_output_success_content,
    structured_output_tool_definition,
)

SCHEMA = {
    "type": "object",
    "required": ["ok", "n"],
    "additionalProperties": False,
    "properties": {"ok": {"type": "boolean"}, "n": {"type": "integer"}},
}


def test_tool_definition_carries_schema_as_parameters():
    definition = structured_output_tool_definition(SCHEMA)
    assert definition["type"] == "function"
    assert definition["function"]["name"] == STRUCTURED_OUTPUT_TOOL_NAME
    assert definition["function"]["parameters"] == SCHEMA


def test_valid_args_produce_canonical_json_content():
    valid, content = evaluate_structured_output_call(SCHEMA, {"ok": True, "n": 7})
    assert valid
    assert json.loads(content) == {"ok": True, "n": 7}
    # canonical (sort_keys) so replayed activities reproduce identical output
    assert content == json.dumps({"n": 7, "ok": True}, sort_keys=True, ensure_ascii=False)


def test_invalid_args_produce_model_facing_error():
    valid, content = evaluate_structured_output_call(SCHEMA, {"ok": "yes"})
    assert not valid
    # starts with "Error:" so _tool_result_error marks the tool result failed
    assert content.startswith("Error:")
    # names the failing paths so the model can correct in-loop
    assert "ok" in content and "n" in content


def test_non_dict_args_rejected():
    valid, content = evaluate_structured_output_call(SCHEMA, "nope")
    assert not valid
    assert content.startswith("Error:")


def test_missing_schema_rejected():
    valid, content = evaluate_structured_output_call(None, {"ok": True, "n": 1})
    assert not valid
    assert content.startswith("Error:")


def test_success_content_detection_is_json_object_only():
    assert structured_output_success_content('{"ok": true}') == '{"ok": true}'
    assert structured_output_success_content("Error: nope") is None
    assert structured_output_success_content("[1, 2]") is None
    assert structured_output_success_content("") is None
    assert structured_output_success_content(None) is None


def test_schema_supports_structured_tool_object_shapes_only():
    assert schema_supports_structured_tool({"type": "object"})
    assert schema_supports_structured_tool({"properties": {"x": {}}})
    assert not schema_supports_structured_tool({"type": "array"})
    assert not schema_supports_structured_tool({"type": "string"})
    assert not schema_supports_structured_tool({})
    assert not schema_supports_structured_tool(None)
