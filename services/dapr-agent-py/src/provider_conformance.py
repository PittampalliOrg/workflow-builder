"""Provider response and chat-history conformance helpers.

The Dapr Agents runtime expects provider adapters to return either an
``LLMChatResponse`` for normal chat or the requested Pydantic model for
structured calls. Chat-completions providers also reject replay histories when
assistant tool calls and tool results are not adjacent, so normalize at the
adapter boundary before provider I/O.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


def strict_json_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Return an OpenAI-compatible strict JSON schema copy."""
    strict_schema = json.loads(json.dumps(schema))

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            properties = node.get("properties")
            if isinstance(properties, dict):
                node["additionalProperties"] = False
                existing_required = node.get("required")
                required = existing_required if isinstance(existing_required, list) else []
                node["required"] = list(dict.fromkeys([*required, *properties.keys()]))
                for value in properties.values():
                    visit(value)
            for key in ("$defs", "definitions"):
                defs = node.get(key)
                if isinstance(defs, dict):
                    for value in defs.values():
                        visit(value)
            for key in ("items", "anyOf", "oneOf", "allOf"):
                value = node.get(key)
                if isinstance(value, list):
                    for item in value:
                        visit(item)
                else:
                    visit(value)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(strict_schema)
    return strict_schema


def parse_structured_response(response_format: Any, content: Any) -> Any:
    """Validate provider text into ``response_format``.

    Providers usually return strict JSON when asked, but memory summarization
    must still return ``ConversationSummary`` instead of a generic chat
    response when a model replies with fenced JSON or plain prose.
    """
    content_text = "" if content is None else str(content)
    parsed: Any = None
    try:
        return response_format.model_validate_json(content_text)
    except Exception:
        pass

    try:
        parsed = json.loads(content_text)
    except (TypeError, ValueError, json.JSONDecodeError):
        match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", content_text, re.DOTALL)
        if match:
            try:
                parsed = json.loads(match.group(1).strip())
            except (TypeError, ValueError, json.JSONDecodeError):
                parsed = None

    if parsed is not None:
        try:
            return response_format.model_validate(parsed)
        except Exception:
            pass

    try:
        field_names = list(response_format.model_fields.keys())
        if field_names:
            return response_format(**{field_names[0]: content_text})
    except Exception:
        pass

    # Last resort: surface the validation error on a direct model_validate_json
    # call so callers get a provider contract failure instead of an unrelated
    # ``LLMChatResponse has no attribute ...`` later in the workflow.
    return response_format.model_validate_json(content_text)


def build_llm_chat_response(
    *,
    content: str,
    tool_calls: list[dict[str, Any]] | None,
    metadata: dict[str, Any] | None,
) -> Any:
    """Build the exact Dapr Agents chat response shape."""
    from dapr_agents.types.message import (
        AssistantMessage,
        LLMChatCandidate,
        LLMChatResponse,
    )

    message_kwargs: dict[str, Any] = {
        "content": content or "",
        "role": "assistant",
    }
    if tool_calls:
        message_kwargs["tool_calls"] = tool_calls
    msg = AssistantMessage(**message_kwargs)
    finish_reason = "tool_use" if tool_calls else "end_turn"
    return LLMChatResponse(
        results=[LLMChatCandidate(message=msg, finish_reason=finish_reason)],
        metadata=metadata or {},
    )


def _message_text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    try:
        return json.dumps(content, ensure_ascii=False)
    except Exception:
        return str(content)


def _tool_call_ids(message: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    for call in message.get("tool_calls") or []:
        if not isinstance(call, dict):
            continue
        call_id = str(call.get("id") or "").strip()
        if call_id:
            ids.append(call_id)
    return ids


def _role_order_error(messages: list[dict[str, Any]]) -> str | None:
    started = False
    pending_tool_ids: list[str] = []
    for idx, message in enumerate(messages):
        role = str(message.get("role") or "")
        if role == "system":
            if started:
                return f"system message at index {idx} appears after conversation start"
            continue
        started = True

        if pending_tool_ids:
            if role != "tool":
                return (
                    f"{role or 'unknown'} message at index {idx} appeared before "
                    f"tool results for {pending_tool_ids}"
                )
            tool_call_id = str(message.get("tool_call_id") or "").strip()
            if tool_call_id not in pending_tool_ids:
                return f"tool message at index {idx} has unmatched tool_call_id {tool_call_id!r}"
            pending_tool_ids.remove(tool_call_id)
            continue

        if role == "tool":
            return f"orphan tool message at index {idx}"
        if role == "assistant":
            ids = _tool_call_ids(message)
            if len(set(ids)) != len(ids):
                return f"assistant message at index {idx} has duplicate tool call ids"
            pending_tool_ids = ids
            continue
        if role != "user":
            return f"unsupported role {role!r} at index {idx}"

    if pending_tool_ids:
        return f"assistant tool calls missing tool results: {pending_tool_ids}"
    return None


def _collapse_invalid_history(
    messages: list[dict[str, Any]],
    *,
    reason: str,
    provider: str,
) -> list[dict[str, Any]]:
    systems: list[dict[str, Any]] = []
    transcript: list[str] = []
    for message in messages:
        role = str(message.get("role") or "user")
        text = _message_text(message).strip()
        if role == "system" and text and not transcript:
            systems.append({"role": "system", "content": text})
            continue
        line = f"[{role}] {text}" if text else f"[{role}]"
        tool_ids = _tool_call_ids(message)
        if tool_ids:
            line += f" [tool_calls={','.join(tool_ids)}]"
        transcript.append(line)

    body = "\n".join(transcript).strip()
    if len(body) > 16_000:
        body = body[-16_000:]
    logger.warning(
        "[provider-conformance] collapsed invalid %s chat history: %s",
        provider,
        reason,
    )
    return [
        *systems,
        {
            "role": "user",
            "content": (
                "Previous conversation context was normalized before provider "
                f"replay because the stored tool-call ordering was invalid: {reason}.\n\n"
                f"{body or 'Continue.'}"
            ),
        },
    ]


def ensure_chat_completions_history(
    messages: list[dict[str, Any]],
    *,
    provider: str,
) -> list[dict[str, Any]]:
    """Return provider-safe chat-completions messages.

    Valid histories pass through unchanged. Invalid replay histories collapse
    into one user context message so providers do not reject the request with
    role-order/tool-call 400s.
    """
    reason = _role_order_error(messages)
    if not reason:
        return messages
    return _collapse_invalid_history(messages, reason=reason, provider=provider)

