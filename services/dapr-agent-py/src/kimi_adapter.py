"""Direct Kimi chat-completions adapter for DaprChatClient.

Kimi exposes an OpenAI-compatible chat completions API at
https://api.moonshot.ai/v1. Keep direct Kimi models on the same durable-agent
contract as Together, Foundry, NVIDIA, and DeepSeek: normal calls return
LLMChatResponse and structured calls return the requested Pydantic model.
"""

from __future__ import annotations

from collections.abc import Iterator
import json
import logging
import os
import socket
import time
from typing import Any
from urllib.error import HTTPError
import urllib.request

from src.provider_conformance import (
    ensure_chat_completions_history,
    parse_structured_response,
    strict_json_schema,
)
from src.mcp_multimodal import decode_multimodal_tool_content

logger = logging.getLogger(__name__)

COMPONENT_MODEL_MAP: dict[str, str] = {
    "llm-kimi-k3": "kimi-k3",
}

# Browser MCP screenshots are typically hundreds of kilobytes once base64
# encoded. Keep the latest visual evidence without replaying every screenshot
# from a long browser session into K3's prompt.
MAX_IMAGE_TOOL_RESULTS_IN_CONTEXT = int(
    os.environ.get("DAPR_AGENT_PY_MAX_IMAGE_TOOL_RESULTS", "3")
)
KIMI_SUPPORTED_IMAGE_MEDIA_TYPES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
}

_KIMI_REASONING_MESSAGE_MODEL: Any = None
_KIMI_REASONING_ENTRY_MODEL: Any = None


def _is_kimi_component(component: str) -> bool:
    return str(component or "") in COMPONENT_MODEL_MAP


def _get_kimi_model(component: str) -> str:
    return COMPONENT_MODEL_MAP.get(
        component,
        os.environ.get("KIMI_DEFAULT_MODEL", "kimi-k3"),
    )


def _kimi_reasoning_state_models() -> tuple[Any, Any]:
    """Return Dapr state models that retain K3 reasoning across tool turns."""
    global _KIMI_REASONING_MESSAGE_MODEL, _KIMI_REASONING_ENTRY_MODEL
    if _KIMI_REASONING_MESSAGE_MODEL is not None:
        return _KIMI_REASONING_MESSAGE_MODEL, _KIMI_REASONING_ENTRY_MODEL

    from pydantic import Field
    from dapr_agents.agents.schemas import AgentWorkflowEntry, AgentWorkflowMessage

    class KimiReasoningWorkflowMessage(AgentWorkflowMessage):
        reasoning_content: str | None = None

    class KimiReasoningWorkflowEntry(AgentWorkflowEntry):
        messages: list[KimiReasoningWorkflowMessage] = Field(default_factory=list)
        system_messages: list[KimiReasoningWorkflowMessage] = Field(
            default_factory=list
        )
        last_message: KimiReasoningWorkflowMessage | None = None

    _KIMI_REASONING_MESSAGE_MODEL = KimiReasoningWorkflowMessage
    _KIMI_REASONING_ENTRY_MODEL = KimiReasoningWorkflowEntry
    return _KIMI_REASONING_MESSAGE_MODEL, _KIMI_REASONING_ENTRY_MODEL


def install_kimi_reasoning_state_schema() -> None:
    """Extend dapr-agent-py's state schema before DurableAgent construction."""
    from dapr_agents.agents.configs import DEFAULT_AGENT_WORKFLOW_BUNDLE

    message_model, entry_model = _kimi_reasoning_state_models()
    DEFAULT_AGENT_WORKFLOW_BUNDLE.message_model_cls = message_model
    DEFAULT_AGENT_WORKFLOW_BUNDLE.entry_model_cls = entry_model


def coerce_kimi_reasoning_message(message: dict[str, Any]) -> Any:
    """Coerce state messages without dropping K3's reasoning_content field."""
    message_model, _ = _kimi_reasoning_state_models()
    return message_model(**message)


def _message_attr(message: Any, name: str, default: Any = None) -> Any:
    if isinstance(message, dict):
        return message.get(name, default)
    return getattr(message, name, default)


def _as_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                item_type = item.get("type")
                if item_type in {"text", "input_text", "output_text"}:
                    parts.append(str(item.get("text", "")))
                elif item_type in {
                    "image",
                    "image_url",
                    "input_image",
                }:
                    # Never serialize base64 image bytes into a text prompt.
                    parts.append("[image]")
                elif item_type in {
                    "video",
                    "video_url",
                    "input_video",
                }:
                    parts.append("[video]")
                elif "content" in item:
                    parts.append(str(item.get("content", "")))
                else:
                    parts.append(json.dumps(item, ensure_ascii=False))
            else:
                parts.append(str(item))
        return "\n".join(part for part in parts if part)
    return str(content)


def _kimi_image_url(block: dict[str, Any]) -> str | None:
    """Return a K3-supported base64/file image URL from common message shapes."""
    source = block.get("source")
    if isinstance(source, dict):
        if source.get("url"):
            candidate = str(source["url"])
        elif source.get("data"):
            media_type = str(
                source.get("media_type") or source.get("mediaType") or "image/png"
            ).lower()
            candidate = f"data:{media_type};base64,{source['data']}"
        else:
            candidate = ""
    elif block.get("data"):
        media_type = str(
            block.get("mimeType")
            or block.get("mediaType")
            or block.get("media_type")
            or "image/png"
        ).lower()
        candidate = f"data:{media_type};base64,{block['data']}"
    else:
        raw_image_url = block.get("image_url")
        if isinstance(raw_image_url, dict):
            candidate = str(raw_image_url.get("url") or "")
        else:
            candidate = str(raw_image_url or "")

    candidate = candidate.strip()
    if candidate.startswith("ms://"):
        return candidate
    if not candidate.startswith("data:"):
        # K3 vision deliberately does not accept public image URLs.
        return None
    header = candidate.split(",", 1)[0].lower()
    if ";base64" not in header:
        return None
    media_type = header[5:].split(";", 1)[0]
    return candidate if media_type in KIMI_SUPPORTED_IMAGE_MEDIA_TYPES else None


def _kimi_video_url(block: dict[str, Any]) -> str | None:
    """Return a K3 uploaded-file video URL from common message shapes."""
    source = block.get("source")
    if isinstance(source, dict):
        if source.get("url"):
            candidate = str(source["url"])
        else:
            candidate = ""
    else:
        raw_video_url = block.get("video_url")
        if isinstance(raw_video_url, dict):
            candidate = str(raw_video_url.get("url") or "")
        else:
            candidate = str(raw_video_url or "")

    candidate = candidate.strip()
    return candidate if candidate.startswith("ms://") else None


def _to_kimi_content_parts(content: Any) -> tuple[list[dict[str, Any]], bool]:
    """Normalize OpenAI, Anthropic, and MCP image blocks for K3 vision."""
    decoded_tool_content = decode_multimodal_tool_content(content)
    if decoded_tool_content is not None:
        content = decoded_tool_content
    if not isinstance(content, list):
        text = _as_text(content)
        return ([{"type": "text", "text": text}] if text else [], False)

    parts: list[dict[str, Any]] = []
    has_media = False
    for item in content:
        if not isinstance(item, dict):
            text = str(item)
            if text:
                parts.append({"type": "text", "text": text})
            continue

        item_type = item.get("type")
        looks_like_video = item_type in {"video", "video_url", "input_video"}
        if looks_like_video:
            has_media = True
            video_url = _kimi_video_url(item)
            if video_url:
                parts.append({"type": "video_url", "video_url": {"url": video_url}})
            else:
                parts.append(
                    {
                        "type": "text",
                        "text": (
                            "[video omitted: Kimi K3 vision requires a supported "
                            "uploaded ms:// video]"
                        ),
                    }
                )
            continue

        looks_like_image = (
            item_type in {"image", "image_url", "input_image"}
            or isinstance(item.get("source"), dict)
            or bool(item.get("mimeType") or item.get("mediaType"))
        )
        if looks_like_image:
            has_media = True
            image_url = _kimi_image_url(item)
            if image_url:
                parts.append({"type": "image_url", "image_url": {"url": image_url}})
            else:
                parts.append(
                    {
                        "type": "text",
                        "text": (
                            "[image omitted: Kimi K3 vision requires a supported "
                            "base64 or ms:// image]"
                        ),
                    }
                )
            continue

        if item_type in {"text", "input_text", "output_text"}:
            text = str(item.get("text", ""))
        else:
            text = _as_text(item)
        if text:
            parts.append({"type": "text", "text": text})
    return parts, has_media


def _normalize_tool_call(call: Any) -> dict[str, Any] | None:
    if not isinstance(call, dict):
        return None
    raw_function = call.get("function")
    function = raw_function if isinstance(raw_function, dict) else {}
    name = str(function.get("name") or call.get("name") or "").strip()
    if not name:
        return None
    raw_args = function.get("arguments", call.get("arguments", "{}"))
    arguments = raw_args if isinstance(raw_args, str) else json.dumps(raw_args or {})
    call_id = str(call.get("id") or call.get("call_id") or "").strip()
    return {
        "id": call_id,
        "type": "function",
        "function": {
            "name": name,
            "arguments": arguments or "{}",
        },
    }


def _normalize_messages_for_kimi(
    prompt: Any,
    raw_messages: list[Any] | None,
) -> list[dict[str, Any]]:
    if raw_messages and isinstance(raw_messages, list):
        source = raw_messages
    elif isinstance(prompt, list):
        source = prompt
    elif isinstance(prompt, str) and prompt:
        source = [{"role": "user", "content": prompt}]
    else:
        source = [{"role": "user", "content": "Continue."}]

    messages: list[dict[str, Any]] = []
    # Chat-completions tool results must remain text messages linked to their
    # tool_call_id. Move image blocks into one trailing user vision message so
    # linkage and role ordering stay valid while K3 receives the screenshots.
    pending_media: list[dict[str, Any]] = []
    for message in source:
        role = str(_message_attr(message, "role", "user") or "user")
        raw_content = _message_attr(message, "content", "")
        text = _as_text(raw_content)

        if role == "system":
            if text:
                messages.append({"role": "system", "content": text})
            continue

        if role == "assistant":
            item: dict[str, Any] = {"role": "assistant", "content": text or None}
            reasoning_content = _as_text(
                _message_attr(message, "reasoning_content", "")
            )
            if reasoning_content:
                item["reasoning_content"] = reasoning_content
            tool_calls = _message_attr(message, "tool_calls", None) or []
            normalized = [
                call
                for call in (_normalize_tool_call(call) for call in tool_calls)
                if call is not None
            ]
            if normalized:
                item["tool_calls"] = normalized
            if item["content"] is None and not normalized:
                item["content"] = ""
            messages.append(item)
            continue

        if role == "tool":
            parts, has_media = _to_kimi_content_parts(raw_content)
            if has_media:
                pending_media.extend(
                    part
                    for part in parts
                    if part.get("type") in {"image_url", "video_url"}
                )
                text = (
                    "\n".join(
                        str(part.get("text") or "")
                        for part in parts
                        if part.get("type") == "text"
                    ).strip()
                    or "[screenshot returned; image attached below]"
                )
            call_id = str(_message_attr(message, "tool_call_id", "") or "").strip()
            if call_id:
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": text or "ok",
                    }
                )
            else:
                messages.append({"role": "user", "content": text or "ok"})
            continue

        parts, has_media = _to_kimi_content_parts(raw_content)
        messages.append(
            {
                "role": "user" if role not in {"user", "assistant"} else role,
                "content": parts if has_media else (text or "Continue."),
            }
        )

    if pending_media and MAX_IMAGE_TOOL_RESULTS_IN_CONTEXT > 0:
        messages.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": ("Visual media returned by a tool (most recent last):"),
                    },
                    *pending_media[-MAX_IMAGE_TOOL_RESULTS_IN_CONTEXT:],
                ],
            }
        )

    if not messages:
        messages.append({"role": "user", "content": "Continue."})
    return ensure_chat_completions_history(messages, provider="kimi")


def _tool_parameters(tool: Any) -> dict[str, Any]:
    if isinstance(tool, dict):
        params = tool.get("parameters")
        if isinstance(params, dict):
            return params
        fn = tool.get("function")
        if isinstance(fn, dict) and isinstance(fn.get("parameters"), dict):
            return fn["parameters"]
    args_model = getattr(tool, "args_model", None)
    if args_model:
        try:
            schema = args_model.model_json_schema()
            if isinstance(schema, dict):
                return schema
        except Exception:
            pass
    return {"type": "object", "properties": {}}


def _tool_name(tool: Any) -> str:
    if isinstance(tool, dict):
        fn = tool.get("function")
        if isinstance(fn, dict) and fn.get("name"):
            return str(fn["name"])
        return str(tool.get("name") or "")
    return str(getattr(tool, "name", "") or "")


def _tool_description(tool: Any, name: str) -> str:
    if isinstance(tool, dict):
        fn = tool.get("function")
        if isinstance(fn, dict) and fn.get("description"):
            return str(fn["description"])
        if tool.get("description"):
            return str(tool["description"])
    return str(getattr(tool, "description", "") or name)


def _convert_tools_for_kimi_chat(
    tools: list[Any] | None,
) -> list[dict[str, Any]] | None:
    if not tools:
        return None
    converted: list[dict[str, Any]] = []
    for tool in tools:
        name = _tool_name(tool)
        if not name:
            continue
        converted.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": _tool_description(tool, name),
                    "parameters": _tool_parameters(tool),
                    # Kimi defaults function schemas to strict MFJS validation.
                    # Our coding tools use provider-agnostic JSON Schema, so keep
                    # provider request validation permissive and let tool execution
                    # validate concrete arguments.
                    "strict": False,
                },
            }
        )
    if not converted:
        return None
    converted.sort(key=lambda item: item["function"].get("name") or "")
    return converted


def _extract_kimi_response(
    response: dict[str, Any],
) -> tuple[str, list[dict[str, Any]], str | None, str]:
    choices = response.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        return "", [], None, ""
    choice = choices[0]
    message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
    content = _as_text(message.get("content"))
    reasoning_content = _as_text(
        message.get("reasoning_content")
        or message.get("reasoning")
        or message.get("thinking")
    )
    tool_calls = [
        call
        for call in (
            _normalize_tool_call(call) for call in (message.get("tool_calls") or [])
        )
        if call is not None
    ]
    finish_reason = choice.get("finish_reason")
    return (
        content,
        tool_calls,
        str(finish_reason) if finish_reason else None,
        reasoning_content,
    )


def _auth_headers() -> tuple[dict[str, str], str]:
    api_key = os.environ.get("KIMI_API_KEY")
    if not api_key:
        raise RuntimeError("No Kimi authentication configured. Set KIMI_API_KEY.")
    return {"Authorization": f"Bearer {api_key}"}, "kimi-api-key"


def _user_agent() -> str:
    configured = os.environ.get("KIMI_USER_AGENT", "").strip()
    if configured:
        return configured
    return "workflow-builder-dapr-agent-py/1.0"


def _make_kimi_request(
    url: str,
    body: dict[str, Any],
    auth_headers: dict[str, str],
) -> urllib.request.Request:
    return urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            **auth_headers,
            "Accept": (
                "text/event-stream" if body.get("stream") else "application/json"
            ),
            "Content-Type": "application/json",
            "User-Agent": _user_agent(),
        },
        method="POST",
    )


def _stream_idle_timeout_seconds() -> float:
    """Return the maximum silence allowed between Kimi SSE bytes.

    ``urllib`` applies this timeout to each blocking socket operation, not to
    the lifetime of the response. A K3 request can therefore reason for much
    longer than this value as long as the provider continues sending SSE data.
    """
    raw_value = os.environ.get("KIMI_STREAM_IDLE_TIMEOUT_SECONDS", "900")
    try:
        timeout = float(raw_value)
    except ValueError as exc:
        raise RuntimeError(
            "KIMI_STREAM_IDLE_TIMEOUT_SECONDS must be a positive number."
        ) from exc
    if timeout <= 0:
        raise RuntimeError(
            "KIMI_STREAM_IDLE_TIMEOUT_SECONDS must be a positive number."
        )
    return timeout


_STREAM_DELTAS_ENABLED = os.environ.get(
    "DAPR_AGENT_PY_STREAM_DELTAS", "true"
).strip().lower() in ("1", "true", "yes", "on")
_DELTA_COALESCE_MS = int(os.environ.get("DAPR_AGENT_PY_DELTA_COALESCE_MS", "80"))
_DELTA_COALESCE_BYTES = int(
    os.environ.get("DAPR_AGENT_PY_DELTA_COALESCE_BYTES", "2048")
)


class _KimiStreamDeltaEmitter:
    """Publish bounded K3 deltas without duplicating the terminal message."""

    def __init__(self) -> None:
        self._session_id: str | None = None
        self._instance_id: str | None = None
        self._publish: Any = None
        self._buffers: dict[tuple[str, int], dict[str, Any]] = {}
        if not _STREAM_DELTAS_ENABLED:
            return
        try:
            from src.event_publisher import (
                get_scoped_session,
                publish_session_event,
            )

            self._session_id, self._instance_id = get_scoped_session()
            if self._session_id:
                self._publish = publish_session_event
        except Exception as exc:  # noqa: BLE001
            logger.debug("[delta-emit] Kimi session lookup failed: %s", exc)

    def append(
        self,
        event_type: str,
        index: int,
        text: str,
        *,
        tool_use_id: str | None = None,
    ) -> None:
        if self._publish is None or not text:
            return
        key = (event_type, index)
        entry = self._buffers.setdefault(
            key,
            {
                "buf": "",
                "cumulative": 0,
                "opened_at_ns": time.monotonic_ns(),
                "tool_use_id": tool_use_id,
            },
        )
        if tool_use_id:
            entry["tool_use_id"] = tool_use_id
        entry["buf"] += text
        entry["cumulative"] += len(text)

        buffered_bytes = len(entry["buf"].encode("utf-8", "ignore"))
        age_ms = (time.monotonic_ns() - entry["opened_at_ns"]) / 1_000_000
        if buffered_bytes >= _DELTA_COALESCE_BYTES or age_ms >= _DELTA_COALESCE_MS:
            self._flush(key)
            entry["opened_at_ns"] = time.monotonic_ns()

    def _flush(self, key: tuple[str, int]) -> None:
        entry = self._buffers.get(key)
        if self._publish is None or not entry or not entry.get("buf"):
            return
        event_type, index = key
        payload: dict[str, Any] = {
            "content_block_index": index,
            "text": entry["buf"],
            "cumulative_len": entry["cumulative"],
        }
        if entry.get("tool_use_id"):
            payload["tool_use_id"] = entry["tool_use_id"]
            payload["partial_json"] = entry["buf"]
        try:
            self._publish(
                self._session_id,
                event_type,
                payload,
                instance_id=self._instance_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("[delta-emit] Kimi publish failed: %s", exc)
        entry["buf"] = ""

    def flush_all(self) -> None:
        for key in list(self._buffers):
            self._flush(key)


def _iter_kimi_sse_data(
    response: Any,
    *,
    idle_timeout_seconds: float,
) -> Iterator[str]:
    """Yield JSON payload strings until Kimi's required ``[DONE]`` event."""
    data_lines: list[str] = []
    while True:
        try:
            raw_line = response.readline()
        except (TimeoutError, socket.timeout) as exc:
            raise TimeoutError(
                "Kimi SSE stream was idle for "
                f"{idle_timeout_seconds:g} seconds before completion."
            ) from exc

        if raw_line == b"" or raw_line == "":
            if data_lines:
                payload = "\n".join(data_lines)
                if payload == "[DONE]":
                    return
                yield payload
            raise RuntimeError(
                "Kimi SSE stream ended before the required data: [DONE] event."
            )

        if isinstance(raw_line, bytes):
            line = raw_line.decode("utf-8", errors="replace")
        else:
            line = str(raw_line)
        line = line.rstrip("\r\n")

        if not line:
            if not data_lines:
                continue
            payload = "\n".join(data_lines)
            data_lines = []
            if payload == "[DONE]":
                return
            yield payload
            continue

        # SSE comments are valid keep-alives. Reading them resets the socket's
        # per-operation idle timeout without producing a chat-completion chunk.
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip(" "))
        elif data_lines:
            # Kimi's no-SDK example treats a non-prefixed line as a
            # continuation of the open data payload. Ignore unsupported SSE
            # fields only when no data event is currently being assembled.
            data_lines.append(line)


def _merge_kimi_stream_tool_calls(
    accumulated: dict[int, dict[str, Any]],
    fragments: Any,
) -> None:
    if not isinstance(fragments, list):
        return
    for position, fragment in enumerate(fragments):
        if not isinstance(fragment, dict):
            continue
        try:
            index = int(fragment.get("index", position))
        except (TypeError, ValueError):
            index = position
        if index < 0:
            continue

        call = accumulated.setdefault(
            index,
            {
                "id": "",
                "type": "function",
                "function": {"name": "", "arguments": ""},
            },
        )
        call_id = fragment.get("id")
        if call_id:
            call["id"] += str(call_id)
        call_type = fragment.get("type")
        if call_type:
            call["type"] = str(call_type)

        raw_function = fragment.get("function")
        if not isinstance(raw_function, dict):
            continue
        function = call["function"]
        name = raw_function.get("name")
        if name:
            function["name"] += str(name)
        arguments = raw_function.get("arguments")
        if arguments is not None:
            function["arguments"] += (
                arguments
                if isinstance(arguments, str)
                else json.dumps(arguments, ensure_ascii=False)
            )


def _read_kimi_sse_response(
    response: Any,
    *,
    idle_timeout_seconds: float,
    request_started_at: float,
) -> tuple[dict[str, Any], float | None]:
    """Aggregate Kimi's OpenAI-compatible chat-completion SSE response."""
    response_id: Any = None
    response_model: Any = None
    response_object: Any = "chat.completion"
    response_created: Any = None
    role = "assistant"
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    streamed_tool_calls: dict[int, dict[str, Any]] = {}
    finish_reason: str | None = None
    usage: dict[str, Any] = {}
    first_token_at: float | None = None
    received_chunk = False
    delta_emitter = _KimiStreamDeltaEmitter()

    for payload in _iter_kimi_sse_data(
        response,
        idle_timeout_seconds=idle_timeout_seconds,
    ):
        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"Kimi SSE stream returned invalid JSON: {payload[:200]}"
            ) from exc
        if not isinstance(chunk, dict):
            raise RuntimeError("Kimi SSE stream returned a non-object JSON chunk.")
        received_chunk = True

        stream_error = chunk.get("error")
        if stream_error:
            if isinstance(stream_error, dict):
                detail = stream_error.get("message") or json.dumps(stream_error)
            else:
                detail = str(stream_error)
            raise RuntimeError(f"Kimi Chat API stream failed: {detail}")

        response_id = chunk.get("id") or response_id
        response_model = chunk.get("model") or response_model
        response_object = chunk.get("object") or response_object
        response_created = chunk.get("created") or response_created
        top_level_usage = chunk.get("usage")
        if isinstance(top_level_usage, dict):
            usage = top_level_usage

        choices = chunk.get("choices")
        if not isinstance(choices, list):
            continue
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            try:
                choice_index = int(choice.get("index", 0))
            except (TypeError, ValueError):
                choice_index = 0
            if choice_index != 0:
                continue

            choice_usage = choice.get("usage")
            if isinstance(choice_usage, dict):
                usage = choice_usage
            if choice.get("finish_reason") is not None:
                finish_reason = str(choice["finish_reason"])

            delta = choice.get("delta")
            if not isinstance(delta, dict):
                continue
            if delta.get("role"):
                role = str(delta["role"])

            reasoning_delta = _as_text(
                delta.get("reasoning_content")
                or delta.get("reasoning")
                or delta.get("thinking")
            )
            content_delta = _as_text(delta.get("content"))
            tool_fragments = delta.get("tool_calls")
            if reasoning_delta or content_delta or tool_fragments:
                first_token_at = first_token_at or time.monotonic()
            if reasoning_delta:
                reasoning_parts.append(reasoning_delta)
                delta_emitter.append("agent.thinking_delta", 0, reasoning_delta)
            if content_delta:
                content_parts.append(content_delta)
                delta_emitter.append("agent.message_delta", 1, content_delta)
            _merge_kimi_stream_tool_calls(streamed_tool_calls, tool_fragments)
            if isinstance(tool_fragments, list):
                for position, fragment in enumerate(tool_fragments):
                    if not isinstance(fragment, dict):
                        continue
                    try:
                        tool_index = int(fragment.get("index", position))
                    except (TypeError, ValueError):
                        tool_index = position
                    if tool_index < 0:
                        continue
                    raw_function = fragment.get("function")
                    if not isinstance(raw_function, dict):
                        continue
                    raw_arguments = raw_function.get("arguments")
                    if raw_arguments is None:
                        continue
                    argument_delta = (
                        raw_arguments
                        if isinstance(raw_arguments, str)
                        else json.dumps(raw_arguments, ensure_ascii=False)
                    )
                    accumulated_call = streamed_tool_calls.get(tool_index) or {}
                    delta_emitter.append(
                        "agent.tool_input_delta",
                        tool_index + 2,
                        argument_delta,
                        tool_use_id=str(accumulated_call.get("id") or "") or None,
                    )

    delta_emitter.flush_all()

    if not received_chunk:
        raise RuntimeError("Kimi SSE stream completed without a response chunk.")

    tool_calls: list[dict[str, Any]] = []
    for index in sorted(streamed_tool_calls):
        normalized = _normalize_tool_call(streamed_tool_calls[index])
        if normalized is None:
            raise RuntimeError(
                f"Kimi SSE stream returned an incomplete tool call at index {index}."
            )
        tool_calls.append(normalized)

    message: dict[str, Any] = {
        "role": role,
        "content": "".join(content_parts),
    }
    reasoning_content = "".join(reasoning_parts)
    if reasoning_content:
        message["reasoning_content"] = reasoning_content
    if tool_calls:
        message["tool_calls"] = tool_calls

    data: dict[str, Any] = {
        "id": response_id,
        "object": response_object,
        "created": response_created,
        "model": response_model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }
        ],
        "usage": usage,
    }
    ttft_ms = (
        (first_token_at - request_started_at) * 1000.0
        if first_token_at is not None
        else None
    )
    return data, ttft_ms


def _header(exc: HTTPError, *names: str) -> str | None:
    headers = exc.headers
    if not headers:
        return None
    for name in names:
        value = headers.get(name)
        if value:
            return str(value)
    return None


def _retry_after_seconds(exc: HTTPError) -> float:
    retry_after = _header(exc, "Retry-After", "retry-after")
    if retry_after:
        try:
            return max(0.0, float(retry_after))
        except ValueError:
            pass

    retry_after_ms = _header(
        exc,
        "Retry-After-Ms",
        "retry-after-ms",
        "X-RateLimit-Reset-Ms",
        "x-ratelimit-reset-ms",
    )
    if retry_after_ms:
        try:
            return max(0.0, float(retry_after_ms) / 1000.0)
        except ValueError:
            pass

    reset = _header(exc, "X-RateLimit-Reset", "x-ratelimit-reset")
    if reset:
        try:
            parsed = float(reset)
            now = time.time()
            return max(0.0, parsed - now) if parsed > now else max(0.0, parsed)
        except ValueError:
            pass

    return max(
        0.0,
        float(os.environ.get("KIMI_RATE_LIMIT_BACKOFF_SECONDS", "65")),
    )


def _rate_limit_max_retries() -> int:
    return max(0, int(os.environ.get("KIMI_RATE_LIMIT_MAX_RETRIES", "3")))


def _publish_llm_usage(
    *,
    model: str,
    usage: dict[str, Any] | None,
    ttft_ms: float | None,
    duration_ms: float | None,
    success: bool,
    error: str | None = None,
) -> None:
    try:
        from src.event_publisher import (
            get_scoped_audit_fields,
            get_scoped_session,
            publish_session_event,
        )

        sid, iid = get_scoped_session()
        if not sid:
            return
        usage = usage or {}
        prompt_cache_hit = int(
            usage.get("cached_tokens") or usage.get("prompt_cache_hit_tokens") or 0
        )
        prompt_cache_miss = int(usage.get("prompt_cache_miss_tokens") or 0)
        prompt_tokens = int(
            usage.get("prompt_tokens") or usage.get("input_tokens") or 0
        )
        input_tokens = (
            prompt_cache_miss
            if prompt_cache_miss
            else max(0, prompt_tokens - prompt_cache_hit)
        )
        payload: dict[str, Any] = {
            "model": model,
            **get_scoped_audit_fields(),
            "input_tokens": input_tokens,
            "output_tokens": int(
                usage.get("completion_tokens") or usage.get("output_tokens") or 0
            ),
            "cache_read_input_tokens": prompt_cache_hit,
            "cache_creation_input_tokens": 0,
            "ttft_ms": ttft_ms,
            "duration_ms": duration_ms,
            "recovery_attempts": 0,
            "success": success,
        }
        if error:
            payload["error"] = error[:200]
        publish_session_event(sid, "agent.llm_usage", payload, instance_id=iid)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[session-event] kimi llm_usage emit failed: %s", exc)


def _apply_kimi_output_mode(
    request_body: dict[str, Any],
    *,
    response_format: Any = None,
    native_json_schema: dict[str, Any] | None = None,
) -> None:
    reasoning_effort = os.environ.get("KIMI_REASONING_EFFORT", "max").strip().lower()
    if reasoning_effort != "max":
        raise RuntimeError("KIMI_REASONING_EFFORT must be 'max' for kimi-k3.")
    request_body["reasoning_effort"] = reasoning_effort

    if response_format is None and native_json_schema is None:
        return

    if response_format is not None:
        schema_name = response_format.__name__
        schema = strict_json_schema(response_format.model_json_schema())
    else:
        schema_name = "structured_output"
        schema = strict_json_schema(native_json_schema or {})
    request_body["response_format"] = {
        "type": "json_schema",
        "json_schema": {
            "name": schema_name,
            "schema": schema,
            "strict": True,
        },
    }


def _messages_contain_json_instruction(messages: list[dict[str, Any]]) -> bool:
    for message in messages:
        if "json" in _as_text(message.get("content")).lower():
            return True
    return False


def _ensure_json_instruction(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if _messages_contain_json_instruction(messages):
        return messages

    instructed = list(messages)
    instruction = "Return a valid JSON object only."
    if instructed and instructed[0].get("role") == "system":
        first = dict(instructed[0])
        content = _as_text(first.get("content")).strip()
        first["content"] = f"{content}\n\n{instruction}" if content else instruction
        instructed[0] = first
    else:
        instructed.insert(0, {"role": "system", "content": instruction})
    return instructed


def _call_kimi_chat(
    component: str,
    messages: list[dict[str, Any]],
    tools: list[Any] | None = None,
    max_tokens: int | None = None,
    response_format: Any = None,
    tool_choice: Any = None,
    native_json_schema: dict[str, Any] | None = None,
) -> dict[str, Any]:
    model = _get_kimi_model(component)
    converted_tools = _convert_tools_for_kimi_chat(tools)

    llm_span = None
    llm_start = time.monotonic()
    try:
        from src.telemetry import start_llm_request_span

        llm_span = start_llm_request_span(
            model,
            fast_mode=False,
            query_source="dapr_agent_py.kimi_adapter",
            system_prompt="\n\n".join(
                str(item.get("content") or "")
                for item in messages
                if item.get("role") == "system"
            )
            or None,
            tools_json=json.dumps(converted_tools) if converted_tools else None,
            messages_for_api=list(messages),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[telemetry] llm_request (kimi) start failed: %s", exc)

    headers, auth_mode = _auth_headers()
    base_url = os.environ.get("KIMI_BASE_URL", "https://api.moonshot.ai/v1")
    url = os.environ.get(
        "KIMI_CHAT_COMPLETIONS_URL",
        f"{base_url.rstrip('/')}/chat/completions",
    )
    idle_timeout_seconds = _stream_idle_timeout_seconds()
    output_cap = max_tokens or int(
        os.environ.get(
            "KIMI_MAX_COMPLETION_TOKENS",
            os.environ.get("KIMI_MAX_TOKENS", "131072"),
        )
    )
    request_body: dict[str, Any] = {
        "model": model,
        "messages": (
            _ensure_json_instruction(messages)
            if response_format is not None or native_json_schema is not None
            else messages
        ),
        "max_completion_tokens": output_cap,
        "stream": True,
    }
    if converted_tools:
        request_body["tools"] = converted_tools
        if tool_choice in (None, "", "auto"):
            request_body["tool_choice"] = "auto"
        elif isinstance(tool_choice, dict):
            request_body["tool_choice"] = tool_choice
        elif tool_choice in {"none", "required"}:
            request_body["tool_choice"] = tool_choice
        else:
            logger.warning(
                "[kimi-chat] ignoring unsupported forced tool_choice=%r",
                tool_choice,
            )
            request_body["tool_choice"] = "auto"
    _apply_kimi_output_mode(
        request_body,
        response_format=response_format,
        native_json_schema=native_json_schema,
    )

    logger.info(
        "[kimi-chat] Calling %s with %d messages, %d tools, auth=%s",
        model,
        len(messages),
        len(converted_tools or []),
        auth_mode,
    )
    data: dict[str, Any]
    ttft_ms: float | None = None
    rate_limit_retries = _rate_limit_max_retries()
    attempt = 0
    try:
        while True:
            req = _make_kimi_request(url, request_body, headers)
            try:
                with urllib.request.urlopen(
                    req,
                    timeout=idle_timeout_seconds,
                ) as resp:
                    data, ttft_ms = _read_kimi_sse_response(
                        resp,
                        idle_timeout_seconds=idle_timeout_seconds,
                        request_started_at=llm_start,
                    )
                break
            except HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                if exc.code == 429 and attempt < rate_limit_retries:
                    delay = _retry_after_seconds(exc)
                    attempt += 1
                    logger.warning(
                        "[kimi-chat] 429 rate limit from %s; retrying in %.1fs "
                        "(attempt %d/%d): %s",
                        model,
                        delay,
                        attempt,
                        rate_limit_retries,
                        detail[:300],
                    )
                    time.sleep(delay)
                    continue
                raise RuntimeError(
                    f"Kimi Chat API failed ({exc.code}): {detail}"
                ) from exc
    except Exception as exc:
        elapsed = (time.monotonic() - llm_start) * 1000.0
        _publish_llm_usage(
            model=model,
            usage=None,
            ttft_ms=ttft_ms if ttft_ms is not None else elapsed,
            duration_ms=elapsed,
            success=False,
            error=str(exc),
        )
        raise

    content, tool_calls, finish_reason, reasoning_content = _extract_kimi_response(data)
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    duration_ms = (time.monotonic() - llm_start) * 1000.0
    effective_ttft_ms = ttft_ms if ttft_ms is not None else duration_ms
    if response_format is not None and not content.strip():
        error = (
            "Kimi Chat API returned empty assistant content for "
            f"structured response_format={getattr(response_format, '__name__', response_format)!r}"
        )
        if reasoning_content:
            error += "; reasoning_content was present but is not structured output"
        _publish_llm_usage(
            model=model,
            usage=usage,
            ttft_ms=effective_ttft_ms,
            duration_ms=duration_ms,
            success=False,
            error=error,
        )
        raise RuntimeError(error)

    if llm_span is not None:
        try:
            from src.telemetry import end_llm_request_span, record_tokens

            input_tokens = int(
                usage.get("prompt_tokens") or usage.get("input_tokens") or 0
            )
            output_tokens = int(
                usage.get("completion_tokens") or usage.get("output_tokens") or 0
            )
            end_llm_request_span(
                llm_span,
                input_tokens=input_tokens or None,
                output_tokens=output_tokens or None,
                success=True,
                has_tool_call=bool(tool_calls),
                ttft_ms=effective_ttft_ms,
                model_output=content or None,
                thinking_output=reasoning_content or None,
            )
            record_tokens(type_="input", count=input_tokens, model=model)
            record_tokens(type_="output", count=output_tokens, model=model)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[telemetry] llm_request (kimi) end failed: %s", exc)

    _publish_llm_usage(
        model=model,
        usage=usage,
        ttft_ms=effective_ttft_ms,
        duration_ms=duration_ms,
        success=True,
    )
    result: dict[str, Any] = {
        "role": "assistant",
        "content": content or "",
        "metadata": {
            "provider": "kimi-chat",
            "model": model,
            "auth_mode": auth_mode,
            "id": data.get("id"),
            "finish_reason": finish_reason,
            "usage": usage,
            "duration_ms": duration_ms,
        },
    }
    if reasoning_content:
        result["reasoning_content"] = reasoning_content
        result["metadata"]["reasoning_content_present"] = True
    if tool_calls:
        result["tool_calls"] = tool_calls

    try:
        from src.telemetry.genai_attrs import (
            set_genai_request_attrs,
            set_genai_response_attrs,
        )

        set_genai_request_attrs(
            system="kimi",
            request_model=model,
            max_tokens=max_tokens,
            tools_count=len(tools) if tools else None,
            streaming=True,
        )
        set_genai_response_attrs(
            response_model=data.get("model") or model,
            response_id=data.get("id"),
            finish_reason=finish_reason,
            usage=usage,
            duration_ms=duration_ms,
            tool_calls_count=len(tool_calls) if tool_calls else None,
            output_chars=len(content) if isinstance(content, str) else None,
        )
    except Exception as _attr_exc:  # noqa: BLE001
        logger.debug("[genai-attrs] kimi span enrichment failed: %s", _attr_exc)

    return result


def _build_kimi_chat_response(
    *,
    content: str,
    reasoning_content: str,
    tool_calls: list[dict[str, Any]] | None,
    metadata: dict[str, Any] | None,
) -> Any:
    """Build a Dapr response whose assistant message retains K3 reasoning."""
    from dapr_agents.types.message import (
        AssistantMessage,
        LLMChatCandidate,
        LLMChatResponse,
    )

    class KimiAssistantMessage(AssistantMessage):
        reasoning_content: str

    message_kwargs: dict[str, Any] = {
        "content": content or "",
        "role": "assistant",
        "reasoning_content": reasoning_content or "",
    }
    if tool_calls:
        message_kwargs["tool_calls"] = tool_calls
    message = KimiAssistantMessage(**message_kwargs)
    return LLMChatResponse(
        results=[
            LLMChatCandidate(
                message=message,
                finish_reason="tool_use" if tool_calls else "end_turn",
            )
        ],
        metadata=metadata or {},
    )


def patch_for_kimi(llm_client: Any) -> None:
    """Patch DaprChatClient to use Kimi's OpenAI-compatible chat endpoint."""

    from dapr_agents.llm.dapr.chat import DaprChatClient

    if getattr(DaprChatClient, "_kimi_patched", False):
        return

    original_generate = DaprChatClient.generate

    def patched_generate(self: Any, *args: Any, **kwargs: Any) -> Any:
        component = getattr(self, "_llm_component", None)
        if component and _is_kimi_component(component):
            prompt = args[0] if args else kwargs.get("prompt", "")
            raw_messages = kwargs.get("messages")
            tools = kwargs.get("tools")
            max_tokens = kwargs.get("max_tokens")
            response_format = kwargs.get("response_format")
            tool_choice = kwargs.get("tool_choice")
            messages = _normalize_messages_for_kimi(
                prompt,
                raw_messages if isinstance(raw_messages, list) else None,
            )
            result = _call_kimi_chat(
                component,
                messages,
                tools=tools,
                max_tokens=max_tokens,
                response_format=response_format,
                tool_choice=tool_choice,
                native_json_schema=(
                    getattr(self, "_response_json_schema", None)
                    if response_format is None
                    else None
                ),
            )

            if response_format is not None:
                return parse_structured_response(
                    response_format,
                    result.get("content", "") or "",
                )

            return _build_kimi_chat_response(
                content=result.get("content", "") or "",
                reasoning_content=result.get("reasoning_content", "") or "",
                tool_calls=result.get("tool_calls") or None,
                metadata=result.get("metadata") or {},
            )

        return original_generate(self, *args, **kwargs)

    DaprChatClient.generate = patched_generate
    DaprChatClient._kimi_patched = True
    logger.info("[kimi-chat] Patched DaprChatClient class for Kimi direct calls")
