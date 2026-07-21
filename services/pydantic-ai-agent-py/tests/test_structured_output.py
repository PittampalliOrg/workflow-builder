from __future__ import annotations

import json

import pytest

from src.structured_output import (
    STRUCTURED_OUTPUT_FEEDBACK_MAX_CHARS,
    STRUCTURED_OUTPUT_MAX_BYTES,
    StructuredOutputConfigError,
    configured_schema,
    evaluate_call,
    output_tool_definition,
)


SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "files"],
    "properties": {
        "summary": {"type": "string", "minLength": 1},
        "files": {
            "type": "array",
            "minItems": 1,
            "items": {"type": "string"},
        },
    },
}


def test_output_tool_is_an_ordinary_function_and_preserves_schema():
    tool = output_tool_definition(SCHEMA)

    assert tool.name == "StructuredOutput"
    assert tool.kind == "function"
    assert tool.parameters_json_schema == SCHEMA
    assert tool.parameters_json_schema is not SCHEMA
    assert tool.strict is False


def test_configured_schema_accepts_object_and_local_ref_roots():
    assert (
        configured_schema(
            {"structuredOutputMode": "tool", "responseJsonSchema": SCHEMA}
        )
        == SCHEMA
    )
    assert (
        configured_schema(
            {
                "structuredOutputMode": "tool",
                "responseJsonSchema": {
                    "$defs": {
                        "result": {
                            "type": "object",
                            "properties": {"summary": {"type": "string"}},
                        }
                    },
                    "$ref": "#/$defs/result",
                },
            }
        )
        is not None
    )
    assert configured_schema({"responseJsonSchema": SCHEMA}) is None


@pytest.mark.parametrize(
    "schema",
    [
        {"type": "array", "items": {"type": "string"}},
        {"type": "object", "required": "summary"},
        {"$ref": "#/$defs/missing"},
        {"$ref": "#missing-anchor"},
        {"$ref": "https://example.com/schema.json"},
        {"$dynamicRef": "https://example.com/schema.json"},
        {"$recursiveRef": "https://example.com/schema.json"},
    ],
)
def test_configured_schema_fails_closed_for_invalid_contracts(schema):
    with pytest.raises(StructuredOutputConfigError):
        configured_schema(
            {"structuredOutputMode": "tool", "responseJsonSchema": schema}
        )


def test_configured_schema_requires_schema_when_tool_mode_is_explicit():
    with pytest.raises(StructuredOutputConfigError, match="non-empty"):
        configured_schema({"structuredOutputMode": "tool"})


def test_recursive_local_schema_is_supported():
    schema = {
        "$defs": {
            "node": {
                "type": "object",
                "properties": {"child": {"$ref": "#/$defs/node"}},
            }
        },
        "$ref": "#/$defs/node",
    }
    assert (
        configured_schema(
            {"structuredOutputMode": "tool", "responseJsonSchema": schema}
        )
        == schema
    )


def test_evaluate_call_returns_canonical_json_for_valid_arguments():
    valid, content = evaluate_call(
        SCHEMA,
        {"files": ["index.html"], "summary": "Built animation"},
    )

    assert valid is True
    assert content == json.dumps(
        {"files": ["index.html"], "summary": "Built animation"},
        sort_keys=True,
        ensure_ascii=False,
    )


def test_evaluate_call_returns_actionable_schema_errors():
    valid, content = evaluate_call(SCHEMA, {"files": []})

    assert valid is False
    assert "<root>: 'summary' is a required property" in content
    assert "files: [] should be non-empty" in content
    assert "call StructuredOutput again" in content


def test_evaluate_call_rejects_provider_argument_errors_and_non_finite_json():
    valid, content = evaluate_call(SCHEMA, {}, args_error="were malformed JSON.")
    assert valid is False
    assert "malformed JSON" in content

    valid, content = evaluate_call(
        {
            "type": "object",
            "properties": {"value": {"type": "number"}},
        },
        {"value": float("nan")},
    )
    assert valid is False
    assert "NaN or Infinity" in content


def test_evaluate_call_caps_utf8_bytes_before_schema_validation():
    valid, content = evaluate_call(
        {
            "type": "object",
            "properties": {"value": {"type": "string"}},
        },
        {"value": "é" * (STRUCTURED_OUTPUT_MAX_BYTES // 2)},
    )

    assert valid is False
    assert f"maximum is {STRUCTURED_OUTPUT_MAX_BYTES}" in content


def test_evaluate_call_caps_model_facing_validation_feedback():
    valid, content = evaluate_call(
        {
            "type": "object",
            "properties": {"value": {"pattern": "^expected$"}},
        },
        {"value": "x" * (STRUCTURED_OUTPUT_FEEDBACK_MAX_CHARS * 2)},
    )

    assert valid is False
    assert "additional validation detail omitted" in content
    assert len(content) < STRUCTURED_OUTPUT_FEEDBACK_MAX_CHARS + 500
