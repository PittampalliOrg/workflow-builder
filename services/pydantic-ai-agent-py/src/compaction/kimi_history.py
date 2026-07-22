"""K3-aware history compaction at the provider and durable boundaries."""

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from pydantic_ai import BinaryContent
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import (
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.tools import RunContext

from src.compaction.tokens import ContextWindowBudgetError
from src.config import (
    COMPACTION_KEEP_MESSAGES,
    COMPACTION_MAX_MESSAGES,
    KIMI_COMPACTION_KEEP_TOKENS,
    KIMI_MAX_INPUT_TOKENS,
    TRANSCRIPT_KEEP_BYTES,
    TRANSCRIPT_MAX_BYTES,
)

if TYPE_CHECKING:
    from pydantic_ai.models import ModelRequestContext

_CHARS_PER_TOKEN = 4


def _without_binary_content(value: Any) -> Any:
    """Remove only typed pixels; ordinary tool JSON remains fully countable."""

    if isinstance(value, BinaryContent):
        return replace(value, data=b"")
    if isinstance(value, list):
        return [_without_binary_content(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_without_binary_content(item) for item in value)
    if isinstance(value, dict):
        return {str(key): _without_binary_content(item) for key, item in value.items()}
    return value


def _token_projection(messages: list[ModelMessage]) -> list[ModelMessage]:
    projected: list[ModelMessage] = []
    for message in messages:
        if not isinstance(message, ModelRequest):
            projected.append(message)
            continue
        parts: list[Any] = []
        for part in message.parts:
            content = getattr(part, "content", None)
            if not isinstance(content, str):
                part = replace(part, content=_without_binary_content(content))
            parts.append(part)
        projected.append(replace(message, parts=parts))
    return projected


def _message_json_sizes(messages: list[ModelMessage]) -> list[int]:
    projected_messages = _token_projection(messages)
    projected = ModelMessagesTypeAdapter.dump_python(projected_messages, mode="json")
    return [
        len(
            json.dumps(
                message,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        )
        for message in projected
    ]


def kimi_history_size_bytes(messages: list[ModelMessage]) -> int:
    sizes = _message_json_sizes(messages)
    return 2 + sum(sizes) + max(0, len(sizes) - 1)


def kimi_durable_history_size_bytes(messages: list[ModelMessage]) -> int:
    projected = ModelMessagesTypeAdapter.dump_python(
        _token_projection(messages), mode="json"
    )
    return len(json.dumps(projected).encode("utf-8"))


def estimate_kimi_message_tokens(messages: list[ModelMessage]) -> int:
    """Conservative heuristic that includes K3 ``ThinkingPart`` content."""

    size = kimi_history_size_bytes(messages)
    return (size + _CHARS_PER_TOKEN - 1) // _CHARS_PER_TOKEN


def durable_history_json_size_bytes(messages: list[dict[str, Any]]) -> int:
    # Dapr durable-task uses json.dumps defaults: ASCII escaping and spaced
    # separators. Keep this domain-side measurement conservative and verify the
    # complete activity envelope through DurablePayloadCodecPort in workflow.py.
    return len(json.dumps(messages).encode("utf-8"))


def _tool_message_pairs(messages: list[ModelMessage]) -> list[tuple[int, int]]:
    pending_calls: dict[str, list[int]] = {}
    pairs: list[tuple[int, int]] = []
    for index, message in enumerate(messages):
        if isinstance(message, ModelResponse):
            for part in message.parts:
                if isinstance(part, ToolCallPart) and part.tool_call_id:
                    pending_calls.setdefault(part.tool_call_id, []).append(index)
        elif isinstance(message, ModelRequest):
            for part in message.parts:
                if not isinstance(part, ToolReturnPart) or not part.tool_call_id:
                    continue
                pending = pending_calls.get(part.tool_call_id)
                if pending:
                    pairs.append((pending.pop(0), index))
    return pairs


def _first_user_message(
    messages: list[ModelMessage],
) -> tuple[int, ModelRequest] | None:
    for index, message in enumerate(messages):
        if isinstance(message, ModelRequest) and any(
            isinstance(part, UserPromptPart) for part in message.parts
        ):
            return index, message
    return None


def _latest_user_message_index(messages: list[ModelMessage]) -> int | None:
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if isinstance(message, ModelRequest) and any(
            isinstance(part, UserPromptPart) for part in message.parts
        ):
            return index
    return None


def _candidate_indices(
    messages: list[ModelMessage], cutoff: int, preserve_first_user_message: bool
) -> list[int]:
    indices = list(range(cutoff, len(messages)))
    first = _first_user_message(messages) if preserve_first_user_message else None
    if first is not None and first[0] < cutoff:
        indices.insert(0, first[0])
    return indices


def _preserves_tool_pairs(
    messages: list[ModelMessage], candidate_indices: list[int]
) -> bool:
    included = set(candidate_indices)
    return all(
        (call_index in included) == (return_index in included)
        for call_index, return_index in _tool_message_pairs(messages)
    )


def _fits(
    messages: list[ModelMessage],
    *,
    max_messages: int,
    max_tokens: int,
    max_bytes: int,
) -> bool:
    provider_size = kimi_history_size_bytes(messages)
    durable_size = kimi_durable_history_size_bytes(messages)
    estimated_tokens = (provider_size + _CHARS_PER_TOKEN - 1) // _CHARS_PER_TOKEN
    return (
        len(messages) <= max_messages
        and estimated_tokens <= max_tokens
        and durable_size <= max_bytes
    )


def compact_kimi_history(
    messages: list[ModelMessage],
    *,
    max_messages: int = COMPACTION_MAX_MESSAGES,
    keep_messages: int = COMPACTION_KEEP_MESSAGES,
    max_tokens: int = KIMI_MAX_INPUT_TOKENS,
    keep_tokens: int = KIMI_COMPACTION_KEEP_TOKENS,
    max_bytes: int = TRANSCRIPT_MAX_BYTES,
    keep_bytes: int = TRANSCRIPT_KEEP_BYTES,
    preserve_first_user_message: bool = True,
) -> list[ModelMessage]:
    """Bound K3 history while keeping the newest message and complete tool pairs."""

    working = list(messages)
    latest_user_index = _latest_user_message_index(working)
    if _fits(
        working,
        max_messages=max_messages,
        max_tokens=max_tokens,
        max_bytes=max_bytes,
    ):
        return working

    if len(working) > 1:
        for message_limit, token_limit, byte_limit in (
            (
                min(keep_messages, max_messages),
                min(keep_tokens, max_tokens),
                min(keep_bytes, max_bytes),
            ),
            (max_messages, max_tokens, max_bytes),
        ):
            for cutoff in range(1, len(working)):
                candidate_indices = _candidate_indices(
                    working, cutoff, preserve_first_user_message
                )
                if (
                    latest_user_index is not None
                    and latest_user_index not in candidate_indices
                ):
                    continue
                if not _preserves_tool_pairs(working, candidate_indices):
                    continue
                candidate = [working[index] for index in candidate_indices]
                if _fits(
                    candidate,
                    max_messages=message_limit,
                    max_tokens=token_limit,
                    max_bytes=byte_limit,
                ):
                    return candidate

    raise ContextWindowBudgetError(
        "Kimi K3 history cannot fit the configured context and durable payload "
        "budgets without removing the current request. Reduce the request or "
        "attached media and try again."
    )


def compact_durable_message_json(
    messages: list[dict[str, Any]],
    *,
    max_messages: int = COMPACTION_MAX_MESSAGES,
    keep_messages: int = COMPACTION_KEEP_MESSAGES,
    max_bytes: int = TRANSCRIPT_MAX_BYTES,
    keep_bytes: int = TRANSCRIPT_KEEP_BYTES,
    max_tokens: int = KIMI_MAX_INPUT_TOKENS,
    keep_tokens: int = KIMI_COMPACTION_KEEP_TOKENS,
) -> list[dict[str, Any]]:
    """Apply the same policy to externalized JSON and enforce its exact size."""

    if durable_history_json_size_bytes(messages) <= max_bytes:
        return messages
    typed = list(ModelMessagesTypeAdapter.validate_python(messages))
    compacted = compact_kimi_history(
        typed,
        max_messages=max_messages,
        keep_messages=keep_messages,
        max_tokens=max_tokens,
        keep_tokens=keep_tokens,
        max_bytes=max_bytes,
        keep_bytes=keep_bytes,
    )
    durable = ModelMessagesTypeAdapter.dump_python(compacted, mode="json")
    if durable_history_json_size_bytes(durable) > max_bytes:
        raise ContextWindowBudgetError(
            "Kimi K3 durable history exceeds the workflow transport budget."
        )
    return durable


@dataclass
class KimiHistoryWindow(AbstractCapability[Any]):
    max_messages: int = COMPACTION_MAX_MESSAGES
    keep_messages: int = COMPACTION_KEEP_MESSAGES
    max_tokens: int = KIMI_MAX_INPUT_TOKENS
    keep_tokens: int = KIMI_COMPACTION_KEEP_TOKENS
    max_bytes: int = TRANSCRIPT_MAX_BYTES
    keep_bytes: int = TRANSCRIPT_KEEP_BYTES
    preserve_first_user_message: bool = True

    async def before_model_request(
        self,
        ctx: RunContext[Any],
        request_context: ModelRequestContext,
    ) -> ModelRequestContext:
        before = list(request_context.messages)
        after = compact_kimi_history(
            before,
            max_messages=self.max_messages,
            keep_messages=self.keep_messages,
            max_tokens=self.max_tokens,
            keep_tokens=self.keep_tokens,
            max_bytes=self.max_bytes,
            keep_bytes=self.keep_bytes,
            preserve_first_user_message=self.preserve_first_user_message,
        )
        request_context.messages = after
        if before != after:
            with ctx.tracer.start_as_current_span("compact_messages") as span:
                if span.is_recording():
                    span.set_attributes(
                        {
                            "gen_ai.conversation.compacted": True,
                            "compaction.strategy": "KimiHistoryWindow",
                            "compaction.messages_before": len(before),
                            "compaction.messages_after": len(after),
                            "compaction.tokens_before": estimate_kimi_message_tokens(
                                before
                            ),
                            "compaction.tokens_after": estimate_kimi_message_tokens(
                                after
                            ),
                            "compaction.bytes_before": kimi_durable_history_size_bytes(
                                before
                            ),
                            "compaction.bytes_after": kimi_durable_history_size_bytes(
                                after
                            ),
                        }
                    )
        return request_context
