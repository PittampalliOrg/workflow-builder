"""pydantic-ai ModelMessage (de)serialization across activity boundaries.

Everything that crosses a Dapr workflow/activity boundary is plain JSON.
pydantic-ai's own ``ModelMessagesTypeAdapter`` is the canonical codec for
``list[ModelMessage]`` — we use it verbatim so the durable history stays a
faithful pydantic-ai conversation (tool calls, tool returns, usage, all
part kinds), not a hand-rolled reimplementation.
"""

from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

from pydantic_ai.messages import (
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
    is_multi_modal_content,
)

from src.config import TOOL_RESULT_MAX_CHARS


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant {value}")


def dump_messages(messages: list[ModelMessage]) -> list[dict[str, Any]]:
    return ModelMessagesTypeAdapter.dump_python(messages, mode="json")


def load_messages(raw: list[dict[str, Any]] | None) -> list[ModelMessage]:
    if not raw:
        return []
    return list(ModelMessagesTypeAdapter.validate_python(raw))


def bootstrap_request(system_prompt: str, task: str) -> ModelRequest:
    parts: list[Any] = []
    if system_prompt.strip():
        parts.append(SystemPromptPart(content=system_prompt.strip()))
    parts.append(UserPromptPart(content=task))
    return ModelRequest(parts=parts)


def user_request(task: str) -> ModelRequest:
    return ModelRequest(parts=[UserPromptPart(content=task)])


def truncate(text: str, limit: int = TOOL_RESULT_MAX_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"… [truncated {len(text) - limit} chars]"


def tool_return_message(
    tool_name: str, tool_call_id: str, content: Any
) -> ModelRequest:
    """One serialized-able ModelRequest carrying a single ToolReturnPart."""
    if isinstance(content, str):
        content = truncate(content)
    elif isinstance(content, list):
        content = [
            item
            if is_multi_modal_content(item) or not isinstance(item, str)
            else truncate(item)
            for item in content
        ]
    return ModelRequest(
        parts=[
            ToolReturnPart(
                tool_name=tool_name,
                tool_call_id=tool_call_id,
                content=content,
            )
        ]
    )


def tool_result_display_text(content: Any) -> str:
    """Return observability/UI text without embedding binary media bytes."""
    part = ToolReturnPart(tool_name="tool", tool_call_id="display", content=content)
    text = part.model_response_str().strip()
    if part.files:
        suffix = f"[{len(part.files)} media part(s) omitted]"
        text = f"{text}\n{suffix}" if text else suffix
    return truncate(text or "[empty tool result]")


def tool_result_has_media(content: Any) -> bool:
    if is_multi_modal_content(content):
        return True
    if isinstance(content, (list, tuple)):
        return any(tool_result_has_media(item) for item in content)
    return False


def messages_have_media(messages: list[ModelMessage]) -> bool:
    """Whether native model-span content capture would include binary media."""
    for message in messages:
        for part in getattr(message, "parts", None) or []:
            if isinstance(part, ToolReturnPart) and part.files:
                return True
            if isinstance(part, UserPromptPart) and not isinstance(part.content, str):
                if any(is_multi_modal_content(item) for item in part.content):
                    return True
    return False


def _safe_user_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for item in content if isinstance(content, (list, tuple)) else [content]:
        if isinstance(item, str):
            parts.append(item)
        elif is_multi_modal_content(item):
            media_type = str(getattr(item, "media_type", None) or "media")
            parts.append(f"[{media_type} omitted]")
        else:
            parts.append(str(item))
    return "\n".join(parts)


def response_text(response: ModelResponse) -> str:
    return "\n".join(
        part.content for part in response.parts if isinstance(part, TextPart)
    ).strip()


def response_tool_calls(response: ModelResponse) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    for part in response.parts:
        if isinstance(part, ToolCallPart):
            raw_args = part.args
            args_error: str | None = None
            if isinstance(raw_args, dict):
                try:
                    encoded = json.dumps(
                        raw_args,
                        ensure_ascii=False,
                        allow_nan=False,
                    )
                    args = raw_args
                    args_size = len(encoded.encode("utf-8"))
                except (TypeError, ValueError) as exc:
                    args = {}
                    args_size = 0
                    args_error = f"must be standards-compliant JSON: {exc}."
            elif isinstance(raw_args, str):
                args_size = len(raw_args.encode("utf-8"))
                if not raw_args.strip():
                    args = {}
                    args_error = "must be a non-empty JSON object."
                else:
                    try:
                        parsed = json.loads(
                            raw_args,
                            parse_constant=_reject_json_constant,
                        )
                        if not isinstance(parsed, dict):
                            raise ValueError("must decode to a JSON object")
                        args = parsed
                    except (TypeError, ValueError) as exc:
                        args = {}
                        args_error = f"must be valid JSON object data: {exc}."
            else:
                args = {}
                args_size = 0
                args_error = "must be valid JSON object data."
            calls.append(
                {
                    "toolName": part.tool_name,
                    "toolCallId": part.tool_call_id,
                    "args": args,
                    "argsSizeBytes": args_size,
                    **({"argsError": args_error} if args_error else {}),
                }
            )
    return calls


def sanitize_invalid_tool_call_args(
    response: ModelResponse, invalid_call_ids: set[str]
) -> ModelResponse:
    """Replace invalid provider arguments before they enter durable history."""
    if not invalid_call_ids:
        return response
    parts = [
        replace(part, args={})
        if isinstance(part, ToolCallPart) and str(part.tool_call_id) in invalid_call_ids
        else part
        for part in response.parts
    ]
    return replace(response, parts=parts)


def openinference_messages(messages: list[ModelMessage]) -> list[dict[str, Any]]:
    """Flatten pydantic-ai messages to the `{role, content}` array the curated
    ClickHouse views (`llm.input_messages` / `llm.output_messages`) and the
    agent-conversation UI render. Lossy by design — the native pydantic-ai
    `gen_ai.input.messages` attrs on the nested chat span keep full fidelity."""
    flat: list[dict[str, Any]] = []
    for message in messages:
        for part in getattr(message, "parts", None) or []:
            kind = getattr(part, "part_kind", "")
            if kind == "system-prompt":
                flat.append({"role": "system", "content": str(part.content)})
            elif kind == "user-prompt":
                flat.append(
                    {
                        "role": "user",
                        "content": _safe_user_content(part.content),
                    }
                )
            elif kind == "tool-return":
                flat.append(
                    {
                        "role": "tool",
                        "name": getattr(part, "tool_name", ""),
                        "content": tool_result_display_text(part.content),
                    }
                )
            elif kind == "retry-prompt":
                flat.append({"role": "user", "content": str(part.content)})
            elif kind == "text":
                flat.append({"role": "assistant", "content": str(part.content)})
            elif kind == "tool-call":
                flat.append(
                    {
                        "role": "assistant",
                        "content": f"[tool_call {part.tool_name}] "
                        + str(part.args or ""),
                    }
                )
            # thinking parts stay out of the flat view on purpose
    return flat
