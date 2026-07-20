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
                content = part.content
                flat.append(
                    {
                        "role": "user",
                        "content": content
                        if isinstance(content, str)
                        else str(content),
                    }
                )
            elif kind == "tool-return":
                flat.append(
                    {
                        "role": "tool",
                        "name": getattr(part, "tool_name", ""),
                        "content": str(part.content),
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
