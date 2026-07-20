"""pydantic-ai ModelMessage (de)serialization across activity boundaries.

Everything that crosses a Dapr workflow/activity boundary is plain JSON.
pydantic-ai's own ``ModelMessagesTypeAdapter`` is the canonical codec for
``list[ModelMessage]`` — we use it verbatim so the durable history stays a
faithful pydantic-ai conversation (tool calls, tool returns, usage, all
part kinds), not a hand-rolled reimplementation.
"""

from __future__ import annotations

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
)

from src.config import TOOL_RESULT_MAX_CHARS


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
    if not isinstance(content, str):
        content = str(content)
    return ModelRequest(
        parts=[
            ToolReturnPart(
                tool_name=tool_name,
                tool_call_id=tool_call_id,
                content=truncate(content),
            )
        ]
    )


def response_text(response: ModelResponse) -> str:
    return "\n".join(
        part.content for part in response.parts if isinstance(part, TextPart)
    ).strip()


def response_tool_calls(response: ModelResponse) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    for part in response.parts:
        if isinstance(part, ToolCallPart):
            calls.append(
                {
                    "toolName": part.tool_name,
                    "toolCallId": part.tool_call_id,
                    "args": part.args_as_dict(),
                }
            )
    return calls
