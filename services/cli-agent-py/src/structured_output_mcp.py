"""Minimal stdio MCP server for CLI StructuredOutput tool mode.

The schema is injected per session through ``CLI_STRUCTURED_OUTPUT_SCHEMA`` by
the CLI MCP config emitter. The CLI sees a first-class MCP tool named
``StructuredOutput`` with that schema as its inputSchema. The hooks layer then
observes the tool call and records the canonical structured output before the
Stop hook finalizes the turn.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Mapping

from src.structured_output import evaluate_structured_output

SERVER_NAME = "workflow-builder-structured-output"
SERVER_VERSION = "0.1.0"
SCHEMA_ENV = "CLI_STRUCTURED_OUTPUT_SCHEMA"
TOOL_NAME = "StructuredOutput"
TOOL_DESCRIPTION = (
    "Report your final structured result. Call this tool exactly once when you "
    "have completed the task. The arguments are the final result object and must "
    "satisfy the required output schema. If the tool reports validation errors, "
    "correct the arguments and call it again."
)


def _load_schema() -> dict[str, Any]:
    raw = os.environ.get(SCHEMA_ENV) or "{}"
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _text_result(text: str, *, is_error: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if is_error:
        result["isError"] = True
    return result


def _validation_error_text(feedback: str) -> str:
    return (
        "Error: StructuredOutput arguments failed schema validation:\n"
        f"{feedback or '<root>: invalid structured output'}\n"
        "Correct the arguments and call StructuredOutput again."
    )


def handle_request(
    message: Mapping[str, Any],
    schema: Mapping[str, Any],
) -> dict[str, Any] | None:
    """Handle one JSON-RPC request/notification."""
    request_id = message.get("id")
    method = message.get("method")

    def response(result: Any) -> dict[str, Any] | None:
        if request_id is None:
            return None
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    def error(code: int, text: str) -> dict[str, Any] | None:
        if request_id is None:
            return None
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": code, "message": text},
        }

    if method == "initialize":
        params = message.get("params")
        protocol_version = "2024-11-05"
        if isinstance(params, Mapping) and isinstance(
            params.get("protocolVersion"),
            str,
        ):
            protocol_version = params["protocolVersion"]
        return response(
            {
                "protocolVersion": protocol_version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            }
        )

    if method in {"notifications/initialized", "notifications/cancelled"}:
        return None

    if method == "ping":
        return response({})

    if method == "tools/list":
        return response(
            {
                "tools": [
                    {
                        "name": TOOL_NAME,
                        "description": TOOL_DESCRIPTION,
                        "inputSchema": dict(schema),
                    }
                ]
            }
        )

    if method == "tools/call":
        params = message.get("params")
        if not isinstance(params, Mapping):
            return response(
                _text_result(
                    "Error: tools/call params must be an object.",
                    is_error=True,
                )
            )
        if params.get("name") != TOOL_NAME:
            return response(
                _text_result(
                    (
                        f"Error: unknown tool {params.get('name')!r}; "
                        f"use {TOOL_NAME}."
                    ),
                    is_error=True,
                )
            )
        result = evaluate_structured_output(
            dict(schema),
            params.get("arguments"),
            source="mcp_tool_call",
        )
        if not result.valid or not result.canonical_text:
            return response(
                _text_result(_validation_error_text(result.feedback), is_error=True)
            )
        return response(_text_result(result.canonical_text))

    return error(-32601, f"Method not found: {method}")


def _iter_messages(line: str) -> list[Mapping[str, Any]]:
    try:
        parsed = json.loads(line)
    except (TypeError, ValueError):
        return []
    if isinstance(parsed, Mapping):
        return [parsed]
    if isinstance(parsed, list):
        return [item for item in parsed if isinstance(item, Mapping)]
    return []


def main() -> int:
    schema = _load_schema()
    for line in sys.stdin:
        if not line.strip():
            continue
        for message in _iter_messages(line):
            response = handle_request(message, schema)
            if response is not None:
                sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
