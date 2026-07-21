"""Synthetic StructuredOutput tool for the durable Pydantic AI runtime.

This intentionally mirrors ``dapr-agent-py`` instead of delegating the run to
``pydantic_ai.Agent``. The Dapr workflow remains the agent loop so every model
request and tool call is a separately persisted activity. Pydantic AI still
owns model transport and message encoding; this adapter adds one ordinary
function tool whose arguments are the workflow's dynamic JSON Schema.
"""

from __future__ import annotations

import json
from copy import deepcopy
from typing import Any

from jsonschema import Draft202012Validator
from pydantic_ai.tools import ToolDefinition

STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput"
MAX_STRUCTURED_OUTPUT_NUDGES = 5
STRUCTURED_OUTPUT_MAX_BYTES = 256 * 1024
STRUCTURED_OUTPUT_FEEDBACK_MAX_CHARS = 8 * 1024

STRUCTURED_OUTPUT_NUDGE = (
    "You have not delivered your final result yet. Call the StructuredOutput "
    "tool exactly once with your final result as its arguments. The arguments "
    "must be a JSON object that satisfies the required output schema. Do not "
    "answer in plain text."
)

_TOOL_DESCRIPTION = (
    "Report your final structured result. Call this tool exactly once after "
    "completing the task. Its arguments are the final result object and must "
    "satisfy the required output schema. If validation fails, correct the "
    "arguments and call this tool again."
)


class StructuredOutputConfigError(ValueError):
    """The caller explicitly requested tool output with an invalid contract."""


def _resolve_local_ref(schema: dict[str, Any], ref: str) -> Any:
    if ref == "#":
        return schema
    if not ref.startswith("#/"):
        return None
    current: Any = schema
    for raw_part in ref[2:].split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _validate_local_refs(schema: dict[str, Any]) -> None:
    anchors: set[str] = set()

    def collect(value: Any) -> None:
        if isinstance(value, dict):
            for key in ("$anchor", "$dynamicAnchor"):
                anchor = value.get(key)
                if isinstance(anchor, str) and anchor:
                    anchors.add(anchor)
            for item in value.values():
                collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)

    collect(schema)

    def check(value: Any) -> None:
        if isinstance(value, dict):
            for key in ("$ref", "$dynamicRef", "$recursiveRef"):
                ref = value.get(key)
                if not isinstance(ref, str):
                    continue
                if not ref.startswith("#"):
                    raise StructuredOutputConfigError(
                        "responseJsonSchema may only use local JSON Schema references"
                    )
                if ref == "#":
                    continue
                if ref.startswith("#/"):
                    if _resolve_local_ref(schema, ref) is None:
                        raise StructuredOutputConfigError(
                            f"responseJsonSchema reference does not resolve: {ref}"
                        )
                elif ref[1:] not in anchors:
                    raise StructuredOutputConfigError(
                        f"responseJsonSchema anchor does not resolve: {ref}"
                    )
            for item in value.values():
                check(item)
        elif isinstance(value, list):
            for item in value:
                check(item)

    check(schema)


def schema_supports_structured_tool(schema: Any) -> bool:
    """Return whether the schema's root describes function-tool arguments."""
    if not isinstance(schema, dict) or not schema:
        return False
    current: Any = schema
    seen: set[str] = set()
    while isinstance(current, dict) and isinstance(current.get("$ref"), str):
        ref = current["$ref"]
        if ref in seen:
            return False
        seen.add(ref)
        current = _resolve_local_ref(schema, ref)
    if not isinstance(current, dict):
        return False
    schema_type = current.get("type")
    if schema_type == "object":
        return True
    return schema_type is None and isinstance(current.get("properties"), dict)


def configured_schema(agent_config: dict[str, Any] | None) -> dict[str, Any] | None:
    """Return a validated schema, failing closed for explicit tool mode."""
    config = agent_config or {}
    if config.get("structuredOutputMode") != "tool":
        return None
    schema = config.get("responseJsonSchema")
    if not isinstance(schema, dict) or not schema:
        raise StructuredOutputConfigError(
            "structuredOutputMode=tool requires a non-empty responseJsonSchema"
        )
    try:
        Draft202012Validator.check_schema(schema)
    except Exception as exc:  # noqa: BLE001
        raise StructuredOutputConfigError(
            f"responseJsonSchema is not valid Draft 2020-12: {exc}"
        ) from exc
    _validate_local_refs(schema)
    if not schema_supports_structured_tool(schema):
        raise StructuredOutputConfigError(
            "StructuredOutput tool arguments require an object-shaped schema"
        )
    return schema


def output_tool_definition(schema: dict[str, Any]) -> ToolDefinition:
    """Build the synthetic function tool through Pydantic AI's public API."""
    return ToolDefinition(
        name=STRUCTURED_OUTPUT_TOOL_NAME,
        description=_TOOL_DESCRIPTION,
        parameters_json_schema=deepcopy(schema),
        kind="function",
        strict=False,
    )


def evaluate_call(
    schema: dict[str, Any],
    tool_args: Any,
    *,
    args_error: str | None = None,
) -> tuple[bool, str]:
    """Validate output-tool arguments and return compact model-facing content."""
    if args_error:
        return False, f"Error: StructuredOutput arguments {args_error}"
    if not isinstance(tool_args, dict):
        return False, (
            "Error: StructuredOutput arguments must be a JSON object that "
            "satisfies the required output schema."
        )

    try:
        encoded = json.dumps(
            tool_args,
            sort_keys=True,
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        return False, (
            "Error: StructuredOutput arguments must be standards-compliant JSON "
            f"without NaN or Infinity: {exc}. Correct the arguments and retry."
        )
    size = len(encoded.encode("utf-8"))
    if size > STRUCTURED_OUTPUT_MAX_BYTES:
        return False, (
            "Error: StructuredOutput result is "
            f"{size} UTF-8 bytes; the maximum is {STRUCTURED_OUTPUT_MAX_BYTES}. "
            "Return a smaller result and call StructuredOutput again."
        )

    try:
        validator = Draft202012Validator(schema)
        errors: list[str] = []
        for error in sorted(
            validator.iter_errors(tool_args),
            key=lambda item: tuple(str(part) for part in item.path),
        ):
            path = "/".join(str(part) for part in error.path) or "<root>"
            errors.append(f"{path}: {error.message}")
            if len(errors) >= 20:
                break
    except Exception as exc:  # noqa: BLE001
        return False, (
            "Error: StructuredOutput schema validation could not be completed: "
            f"{type(exc).__name__}: {exc}."
        )
    if errors:
        feedback = "\n".join(errors)
        if len(feedback) > STRUCTURED_OUTPUT_FEEDBACK_MAX_CHARS:
            feedback = (
                feedback[:STRUCTURED_OUTPUT_FEEDBACK_MAX_CHARS]
                + "\n[additional validation detail omitted]"
            )
        return False, (
            "Error: StructuredOutput arguments failed schema validation:\n"
            + feedback
            + "\nCorrect the arguments and call StructuredOutput again."
        )
    return True, encoded
