from __future__ import annotations

from src.structured_output import (
    extract_structured_output_from_text,
    is_structured_output_tool,
    schema_supports_structured_output,
)
from src.structured_output_mcp import TOOL_DESCRIPTION, handle_request


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


def test_structured_output_mcp_lists_schema_tool():
    schema = {"type": "object", "properties": {"answer": {"type": "string"}}}

    response = handle_request(
        {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        schema,
    )

    assert response == {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "tools": [
                {
                    "name": "StructuredOutput",
                    "description": TOOL_DESCRIPTION,
                    "inputSchema": schema,
                }
            ]
        },
    }


def test_structured_output_mcp_validates_tool_call():
    schema = {
        "type": "object",
        "properties": {"answer": {"type": "string"}},
        "required": ["answer"],
        "additionalProperties": False,
    }

    valid = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "StructuredOutput", "arguments": {"answer": "yes"}},
        },
        schema,
    )
    assert valid["result"]["content"][0]["text"] == '{"answer": "yes"}'
    assert valid["result"]["structuredContent"] == {"answer": "yes"}
    assert "isError" not in valid["result"]

    invalid = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "StructuredOutput", "arguments": {}},
        },
        schema,
    )
    assert invalid["result"]["isError"] is True
    assert "failed schema validation" in invalid["result"]["content"][0]["text"]
