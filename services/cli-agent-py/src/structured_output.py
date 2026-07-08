"""Structured-output helpers for one-shot CLI workflow runs.

The Dapr parent remains the final authority: ``record_script_call_result``
validates the child result against the requested Draft 2020-12 JSON Schema.
This module gives the CLI hook layer enough local feedback to keep a headless
turn alive until it emits a parseable, schema-shaped object, then canonicalizes
that object into the ``session_workflow`` result contract.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Mapping

STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput"
STRUCTURED_OUTPUT_MODE_STOP_HOOK = "stopHook"
STRUCTURED_OUTPUT_MODE_TOOL = "tool"

STRUCTURED_OUTPUT_NUDGE = (
    "Your final response must be a single JSON object that validates against "
    "the required output schema. Return only the corrected JSON object, with no "
    "prose before or after it."
)


def max_structured_output_nudges() -> int:
    try:
        return max(0, int(os.environ.get("CLI_STRUCTURED_OUTPUT_NUDGES", "5")))
    except (TypeError, ValueError):
        return 5


@dataclass(frozen=True)
class StructuredOutputResult:
    valid: bool
    value: dict[str, Any] | None = None
    canonical_text: str | None = None
    feedback: str = ""
    source: str = ""


def schema_supports_structured_output(schema: Any) -> bool:
    """CLI structured finalization currently supports object-shaped schemas."""
    if not isinstance(schema, dict) or not schema:
        return False
    schema_type = schema.get("type")
    if schema_type == "object":
        return True
    return schema_type is None and isinstance(schema.get("properties"), dict)


def canonical_json(value: Mapping[str, Any]) -> str:
    return json.dumps(dict(value), sort_keys=True, ensure_ascii=False)


def is_structured_output_tool(tool_name: Any) -> bool:
    if not isinstance(tool_name, str):
        return False
    name = tool_name.strip()
    if name == STRUCTURED_OUTPUT_TOOL_NAME:
        return True
    return name.startswith("mcp__") and name.endswith(f"__{STRUCTURED_OUTPUT_TOOL_NAME}")


def validate_structured_output(schema: Any, value: Any) -> list[str]:
    if not isinstance(schema, dict) or not schema:
        return ["<schema>: no output schema is configured"]
    if not isinstance(value, dict):
        return ["<root>: output must be a JSON object"]
    try:
        from jsonschema import Draft202012Validator  # type: ignore

        validator = Draft202012Validator(schema)
        errors = []
        for err in sorted(validator.iter_errors(value), key=lambda e: list(e.path)):
            path = "/".join(str(part) for part in err.path) or "<root>"
            errors.append(f"{path}: {err.message}")
        return errors[:20]
    except Exception:
        return _fallback_validation_errors(schema, value)[:20]


def evaluate_structured_output(
    schema: Any, value: Any, *, source: str = ""
) -> StructuredOutputResult:
    errors = validate_structured_output(schema, value)
    if errors:
        return StructuredOutputResult(
            valid=False,
            feedback="\n".join(errors),
            source=source,
        )
    if not isinstance(value, dict):
        return StructuredOutputResult(
            valid=False,
            feedback="<root>: output must be a JSON object",
            source=source,
        )
    return StructuredOutputResult(
        valid=True,
        value=dict(value),
        canonical_text=canonical_json(value),
        source=source,
    )


def extract_structured_output_from_text(schema: Any, text: Any) -> StructuredOutputResult:
    if not isinstance(text, str) or not text.strip():
        return StructuredOutputResult(
            valid=False,
            feedback="<root>: no assistant output was available",
            source="assistant_text",
        )
    candidate = _extract_json_object(text)
    if candidate is None:
        return StructuredOutputResult(
            valid=False,
            feedback="<root>: assistant output did not contain a JSON object",
            source="assistant_text",
        )
    return evaluate_structured_output(schema, candidate, source="assistant_text")


def _extract_json_object(text: str) -> dict[str, Any] | None:
    stripped = text.strip()
    fenced = _extract_fenced_json(stripped)
    if fenced is not None:
        return fenced
    try:
        parsed = json.loads(stripped)
        if isinstance(parsed, dict):
            return parsed
    except (TypeError, ValueError):
        pass
    decoder = json.JSONDecoder()
    for index, char in enumerate(stripped):
        if char != "{":
            continue
        try:
            parsed, _end = decoder.raw_decode(stripped[index:])
        except ValueError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _extract_fenced_json(text: str) -> dict[str, Any] | None:
    fence = "```"
    start = text.find(fence)
    while start != -1:
        body_start = start + len(fence)
        line_end = text.find("\n", body_start)
        if line_end == -1:
            return None
        lang = text[body_start:line_end].strip().lower()
        end = text.find(fence, line_end + 1)
        if end == -1:
            return None
        if lang in {"", "json", "jsonc"}:
            block = text[line_end + 1 : end].strip()
            try:
                parsed = json.loads(block)
                if isinstance(parsed, dict):
                    return parsed
            except (TypeError, ValueError):
                pass
        start = text.find(fence, end + len(fence))
    return None


def _fallback_validation_errors(schema: Any, value: Any, path: str = "<root>") -> list[str]:
    if isinstance(schema, bool):
        return [] if schema else [f"{path}: schema rejects all values"]
    if not isinstance(schema, dict):
        return []
    errors: list[str] = []
    if "const" in schema and value != schema.get("const"):
        errors.append(f"{path}: value must equal {schema.get('const')!r}")
    if isinstance(schema.get("enum"), list) and value not in schema["enum"]:
        errors.append(f"{path}: value is not one of the allowed enum values")

    for keyword in ("allOf", "anyOf", "oneOf"):
        subschemas = schema.get(keyword)
        if not isinstance(subschemas, list) or not subschemas:
            continue
        results = [
            _fallback_validation_errors(item, value, path)
            for item in subschemas
            if isinstance(item, (dict, bool))
        ]
        passing = sum(1 for item_errors in results if not item_errors)
        if keyword == "allOf":
            for item_errors in results:
                errors.extend(item_errors)
        elif keyword == "anyOf" and passing == 0:
            errors.append(f"{path}: value does not match any allowed schema")
        elif keyword == "oneOf" and passing != 1:
            errors.append(f"{path}: value must match exactly one allowed schema")

    schema_type = schema.get("type")
    if schema_type is None and isinstance(schema.get("properties"), dict):
        schema_type = "object"
    allowed_types = schema_type if isinstance(schema_type, list) else [schema_type]
    allowed_types = [item for item in allowed_types if isinstance(item, str)]
    if allowed_types and not any(_matches_type(value, item) for item in allowed_types):
        errors.append(f"{path}: expected {', '.join(allowed_types)}")
        return errors

    if _matches_type(value, "object"):
        properties = schema.get("properties")
        if isinstance(properties, dict):
            required = schema.get("required")
            if isinstance(required, list):
                for key in required:
                    if isinstance(key, str) and key not in value:
                        errors.append(f"{path}/{key}: required property is missing")
            for key, subschema in properties.items():
                if isinstance(key, str) and key in value:
                    errors.extend(
                        _fallback_validation_errors(
                            subschema,
                            value[key],
                            f"{path}/{key}",
                        )
                    )
            additional = schema.get("additionalProperties", True)
            extras = [key for key in value if key not in properties]
            if additional is False:
                for key in extras:
                    errors.append(f"{path}/{key}: additional property is not allowed")
            elif isinstance(additional, dict):
                for key in extras:
                    errors.extend(
                        _fallback_validation_errors(
                            additional,
                            value[key],
                            f"{path}/{key}",
                        )
                    )
    elif _matches_type(value, "array"):
        items = schema.get("items")
        if isinstance(items, dict):
            for index, item in enumerate(value):
                errors.extend(_fallback_validation_errors(items, item, f"{path}/{index}"))
    elif isinstance(value, str):
        min_length = schema.get("minLength")
        max_length = schema.get("maxLength")
        if isinstance(min_length, int) and len(value) < min_length:
            errors.append(f"{path}: string is shorter than {min_length}")
        if isinstance(max_length, int) and len(value) > max_length:
            errors.append(f"{path}: string is longer than {max_length}")
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        maximum = schema.get("maximum")
        if isinstance(minimum, (int, float)) and value < minimum:
            errors.append(f"{path}: number is less than {minimum}")
        if isinstance(maximum, (int, float)) and value > maximum:
            errors.append(f"{path}: number is greater than {maximum}")
    return errors


def _matches_type(value: Any, schema_type: str) -> bool:
    if schema_type == "object":
        return isinstance(value, dict)
    if schema_type == "array":
        return isinstance(value, list)
    if schema_type == "string":
        return isinstance(value, str)
    if schema_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if schema_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if schema_type == "boolean":
        return isinstance(value, bool)
    if schema_type == "null":
        return value is None
    return True
