"""StructuredOutput tool — the Claude Code structured-output mechanism, ported
to the durable runtime.

A dynamic-script ``agent(..., {schema})`` call routed to a provider WITHOUT a
strict schema mode (GLM today) gets a synthetic ``StructuredOutput`` tool whose
per-request definition carries the call's JSON Schema as its ``parameters``
(injected adapter-side from ``_response_json_schema``; the tool is never
registered on the tool executor). The model delivers its final result by
calling the tool:

- invalid arguments -> an error ToolMessage (in-loop retry: the model sees the
  validation errors on its next turn, same session);
- valid arguments  -> the canonical JSON becomes the session's final output
  text, so the orchestrator's journal validation (Tier 3) passes unchanged.

Enforcement of "you must call the tool" lives in the durable agent loop
(``_agent_workflow_strict_sequential``): when the model tries to finish without
a valid StructuredOutput call, the loop injects a corrective user message and
continues, capped at MAX_STRUCTURED_OUTPUT_NUDGES. That guard plays the role of
Claude Code's Stop hook (advisory-only in this runtime); GLM's API honors only
``tool_choice: "auto"`` so the tool cannot be forced — availability + prompt +
loop guard is exactly Claude Code's own design, and it composes with agents
that need Read/Bash/MCP tools before emitting their result.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput"

# Mirrors Claude Code's MAX_STRUCTURED_OUTPUT_RETRIES: how many times the loop
# re-prompts a model that finished without a valid StructuredOutput call before
# giving up and letting the Tier-3 journal retry take over.
MAX_STRUCTURED_OUTPUT_NUDGES = 5

STRUCTURED_OUTPUT_NUDGE = (
    "You have not delivered your final result yet. Call the StructuredOutput "
    "tool exactly once with your final result as its arguments; the arguments "
    "must be a JSON object that satisfies the required output schema. Do not "
    "answer in plain text."
)

_TOOL_DESCRIPTION = (
    "Report your final structured result. Call this tool exactly once when you "
    "have completed the task. The arguments ARE the final result object and "
    "must satisfy the required output schema. If the tool reports validation "
    "errors, correct the arguments and call it again."
)


def structured_output_tool_definition(schema: dict[str, Any]) -> dict[str, Any]:
    """OpenAI-function-format tool definition whose parameters ARE the call's
    JSON Schema (the Claude Code ``inputJSONSchema`` pattern)."""
    return {
        "type": "function",
        "function": {
            "name": STRUCTURED_OUTPUT_TOOL_NAME,
            "description": _TOOL_DESCRIPTION,
            "parameters": schema,
        },
    }


def schema_supports_structured_tool(schema: Any) -> bool:
    """Tool arguments are always JSON objects, so only object-shaped schemas
    (explicit type=object, or no type with properties) can ride the tool."""
    if not isinstance(schema, dict) or not schema:
        return False
    schema_type = schema.get("type")
    if schema_type == "object":
        return True
    return schema_type is None and isinstance(schema.get("properties"), dict)


def _validation_errors(schema: dict[str, Any], value: Any) -> list[str]:
    try:
        from jsonschema import Draft202012Validator
    except Exception as exc:  # noqa: BLE001 — validator missing: degrade open
        logger.warning("[structured-output] jsonschema unavailable: %s", exc)
        return []
    try:
        validator = Draft202012Validator(schema)
        errors = []
        for err in sorted(validator.iter_errors(value), key=lambda e: list(e.path)):
            path = "/".join(str(p) for p in err.path) or "<root>"
            errors.append(f"{path}: {err.message}")
        return errors[:20]
    except Exception as exc:  # noqa: BLE001 — malformed schema: degrade open
        logger.warning("[structured-output] schema validation crashed: %s", exc)
        return []


def evaluate_structured_output_call(
    schema: Any, tool_args: Any
) -> tuple[bool, str]:
    """Validate a StructuredOutput tool call. Returns (valid, content).

    On success content is the canonical JSON of the arguments (this exact text
    becomes the session's final output). On failure content is a model-facing
    error message; it starts with "Error:" so _tool_result_error flags the tool
    result as failed in telemetry.
    """
    if not isinstance(schema, dict) or not schema:
        return False, (
            "Error: StructuredOutput is not available for this session (no "
            "output schema is configured). Provide your answer as normal text."
        )
    if not isinstance(tool_args, dict):
        return False, (
            "Error: StructuredOutput arguments must be a JSON object that "
            "satisfies the required output schema."
        )
    errors = _validation_errors(schema, tool_args)
    if errors:
        return False, (
            "Error: StructuredOutput arguments failed schema validation:\n"
            + "\n".join(errors)
            + "\nCorrect the arguments and call StructuredOutput again."
        )
    return True, json.dumps(tool_args, sort_keys=True, ensure_ascii=False)


def structured_output_success_content(content: Any) -> str | None:
    """Deterministic success test for a StructuredOutput ToolMessage, safe for
    the workflow body: success iff the content parses as a JSON object (the
    failure path always produces a non-JSON "Error: ..." message)."""
    if not isinstance(content, str) or not content.strip():
        return None
    try:
        parsed = json.loads(content)
    except (TypeError, ValueError):
        return None
    return content if isinstance(parsed, dict) else None
