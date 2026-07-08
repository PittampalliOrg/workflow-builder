from __future__ import annotations

from src.structured_output import (
    extract_structured_output_from_text,
    is_structured_output_tool,
    schema_supports_structured_output,
)


def test_extracts_and_canonicalizes_fenced_json_object():
    schema = {
        "type": "object",
        "properties": {
            "b": {"type": "number"},
            "a": {"type": "string"},
        },
        "required": ["a", "b"],
        "additionalProperties": False,
    }

    result = extract_structured_output_from_text(
        schema,
        'done\n```json\n{"b":2,"a":"x"}\n```',
    )

    assert result.valid is True
    assert result.value == {"a": "x", "b": 2}
    assert result.canonical_text == '{"a": "x", "b": 2}'
    assert result.source == "assistant_text"


def test_rejects_text_without_json_object():
    schema = {"type": "object", "properties": {"a": {"type": "string"}}}

    result = extract_structured_output_from_text(schema, "plain prose")

    assert result.valid is False
    assert "did not contain a JSON object" in result.feedback


def test_rejects_missing_required_property():
    schema = {
        "type": "object",
        "properties": {"a": {"type": "string"}},
        "required": ["a"],
    }

    result = extract_structured_output_from_text(schema, "{}")

    assert result.valid is False
    assert "a" in result.feedback


def test_schema_and_tool_name_helpers():
    assert schema_supports_structured_output({"properties": {"a": {"type": "string"}}})
    assert not schema_supports_structured_output({"type": "array"})
    assert is_structured_output_tool("StructuredOutput")
    assert is_structured_output_tool("mcp__structured__StructuredOutput")
    assert not is_structured_output_tool("OtherTool")
