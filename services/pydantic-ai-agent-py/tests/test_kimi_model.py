"""Kimi model construction + settings (pydantic-ai model classes)."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from src.compaction.tokens import (
    ContextWindowBudgetError,
    get_completion_token_budget,
)
from src.messages_io import tool_return_message
from src.structured_output import output_tool_definition
from src.workflow import (
    _kimi_model_profile,
    apply_context_completion_budget,
    build_model,
    build_model_settings,
    is_provider_context_window_error,
    resolve_kimi_reasoning_effort,
)


def test_build_model_requires_api_key(monkeypatch):
    monkeypatch.delenv("KIMI_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="KIMI_API_KEY"):
        build_model()


def test_build_model_is_pydantic_ai_openai_chat_model(monkeypatch):
    monkeypatch.setenv("KIMI_API_KEY", "test-key")
    model = build_model()
    from pydantic_ai.models.openai import OpenAIChatModel

    assert isinstance(model, OpenAIChatModel)
    assert model.model_name == "kimi-k3"
    assert model.provider.client.max_retries == 0


def test_model_settings_enforce_kimi_contract(monkeypatch):
    monkeypatch.delenv("KIMI_REASONING_EFFORT", raising=False)
    settings = build_model_settings()
    assert settings["temperature"] == 1
    assert settings["frequency_penalty"] == 0
    assert settings["max_tokens"] == 131_072
    assert settings["extra_body"] == {"reasoning_effort": "max"}
    assert settings["timeout"] > 0


@pytest.mark.parametrize("effort", ["low", "high", "max"])
def test_model_settings_honor_per_agent_kimi_reasoning_effort(monkeypatch, effort: str):
    monkeypatch.setenv("KIMI_REASONING_EFFORT", "max")
    settings = build_model_settings({"reasoningEffort": effort.upper()})
    assert settings["extra_body"] == {"reasoning_effort": effort}


def test_kimi_reasoning_effort_uses_env_default_and_rejects_unsupported(
    monkeypatch, caplog
):
    monkeypatch.setenv("KIMI_REASONING_EFFORT", "high")
    assert resolve_kimi_reasoning_effort() == "high"
    assert resolve_kimi_reasoning_effort({"reasoningEffort": "low"}) == "low"
    assert resolve_kimi_reasoning_effort({"reasoningEffort": "medium"}) == "max"
    assert "defaulting to 'max'" in caplog.text


def test_context_budget_reserves_completion_and_reduces_it_near_limit():
    assert get_completion_token_budget("kimi-k3", input_tokens=904_504) == 131_072
    assert get_completion_token_budget("kimi-k3", input_tokens=910_000) == 125_576
    with pytest.raises(ContextWindowBudgetError):
        get_completion_token_budget("kimi-k3", input_tokens=1_035_576)


def test_model_settings_apply_context_budget_after_compaction():
    from pydantic_ai.messages import ModelRequest, UserPromptPart

    messages = [ModelRequest(parts=[UserPromptPart(content="x" * (910_000 * 4))])]
    settings = apply_context_completion_budget(build_model_settings(), messages)

    assert 120_000 < settings["max_tokens"] < 131_072


@pytest.mark.parametrize(
    ("status_code", "body", "message", "expected"),
    [
        (400, {"error": "context length exceeds token limit"}, "bad request", True),
        (400, None, "max_completion_tokens exceeds context window", True),
        (400, {"error": "unknown tool"}, "bad request", False),
        (500, {"error": "context window"}, "server error", False),
    ],
)
def test_provider_context_window_error_detection(status_code, body, message, expected):
    class ProviderError(Exception):
        pass

    exc = ProviderError(message)
    exc.status_code = status_code
    exc.body = body

    assert is_provider_context_window_error(exc) is expected


def test_kimi_chat_wire_uses_dapr_style_output_tool_and_replays_reasoning():
    from pydantic_ai.messages import ModelRequest, UserPromptPart
    from pydantic_ai.models import ModelRequestParameters
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["summary"],
        "properties": {"summary": {"type": "string"}},
    }
    captured: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(
            {
                "headers": dict(request.headers),
                "path": request.url.path,
                "body": json.loads(request.content),
            }
        )
        if len(captured) == 1:
            message = {
                "role": "assistant",
                "content": None,
                "reasoning_content": "I should deliver the validated result.",
                "tool_calls": [
                    {
                        "id": "so1",
                        "type": "function",
                        "function": {
                            "name": "StructuredOutput",
                            "arguments": '{"summary":"done"}',
                        },
                    }
                ],
            }
            finish_reason = "tool_calls"
        else:
            message = {"role": "assistant", "content": "acknowledged"}
            finish_reason = "stop"
        return httpx.Response(
            200,
            json={
                "id": f"chatcmpl-{len(captured)}",
                "object": "chat.completion",
                "created": 1,
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": finish_reason,
                        "message": message,
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            },
        )

    async def exercise() -> None:
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            model = OpenAIChatModel(
                "kimi-k3",
                provider=OpenAIProvider(
                    base_url="https://api.kimi.com/coding/v1",
                    api_key="wire-test-key",
                    http_client=http_client,
                ),
                profile=_kimi_model_profile,
            )
            params = ModelRequestParameters(
                function_tools=[output_tool_definition(schema)],
                output_mode="text",
                output_tools=[],
                allow_text_output=True,
            )
            first = ModelRequest(parts=[UserPromptPart(content="finish the task")])
            response = await model.request([first], build_model_settings(), params)
            returned = tool_return_message(
                "StructuredOutput", "so1", '{"summary": "done"}'
            )
            await model.request(
                [first, response, returned], build_model_settings(), params
            )

    asyncio.run(exercise())

    first = captured[0]
    assert first["path"] == "/coding/v1/chat/completions"
    assert first["headers"]["authorization"] == "Bearer wire-test-key"
    body = first["body"]
    assert body["model"] == "kimi-k3"
    assert body["tool_choice"] == "auto"
    assert body["reasoning_effort"] == "max"
    assert body["temperature"] == 1
    assert body["frequency_penalty"] == 0
    assert body["max_completion_tokens"] == 131_072
    assert "max_tokens" not in body
    assert "response_format" not in body
    structured = body["tools"][0]["function"]
    assert structured["name"] == "StructuredOutput"
    assert structured["parameters"] == schema
    assert "strict" not in structured or structured["strict"] is False

    assistant = next(
        message
        for message in captured[1]["body"]["messages"]
        if message["role"] == "assistant"
    )
    assert assistant["reasoning_content"] == ("I should deliver the validated result.")


def test_kimi_chat_wire_sends_tool_media_as_native_image_parts():
    from pydantic_ai.messages import BinaryContent, ModelRequest, UserPromptPart
    from pydantic_ai.models import ModelRequestParameters
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-media",
                "object": "chat.completion",
                "created": 1,
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "visible"},
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 1,
                    "total_tokens": 11,
                },
            },
        )

    async def exercise() -> None:
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            model = OpenAIChatModel(
                "kimi-k3",
                provider=OpenAIProvider(
                    base_url="https://api.kimi.com/coding/v1",
                    api_key="wire-test-key",
                    http_client=http_client,
                ),
                profile=_kimi_model_profile,
            )
            request = ModelRequest(parts=[UserPromptPart(content="inspect it")])
            returned = tool_return_message(
                "ReadMediaFile",
                "media1",
                [
                    "Read screenshot.png",
                    BinaryContent(data=b"png-pixels", media_type="image/png"),
                ],
            )
            await model.request(
                [request, returned],
                build_model_settings(),
                ModelRequestParameters(),
            )

    asyncio.run(exercise())

    tool_message = next(m for m in captured["messages"] if m["role"] == "tool")
    assert tool_message["tool_call_id"] == "media1"
    media_message = captured["messages"][-1]
    assert media_message["role"] == "user"
    assert isinstance(media_message["content"], list)
    image = next(
        part for part in media_message["content"] if part["type"] == "image_url"
    )
    assert image["image_url"]["url"].startswith("data:image/png;base64,")
    assert "BinaryContent" not in json.dumps(captured)


def test_kimi_chat_stream_aggregates_reasoning_fragmented_tools_and_usage():
    from pydantic_ai.messages import (
        ModelRequest,
        ThinkingPart,
        ToolCallPart,
        UserPromptPart,
    )
    from pydantic_ai.models import ModelRequestParameters
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    captured: dict = {}

    def chunk(delta, finish_reason=None):
        return {
            "id": "cmpl-stream",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "kimi-k3",
            "choices": [
                {
                    "index": 0,
                    "delta": delta,
                    "finish_reason": finish_reason,
                }
            ],
        }

    stream_chunks = [
        chunk({"role": "assistant", "reasoning_content": "Think "}),
        chunk({"reasoning_content": "hard."}),
        chunk(
            {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "so-stream",
                        "type": "function",
                        "function": {
                            "name": "StructuredOutput",
                            "arguments": '{"summ',
                        },
                    }
                ]
            }
        ),
        chunk(
            {
                "tool_calls": [
                    {
                        "index": 0,
                        "function": {"arguments": 'ary":"done"}'},
                    }
                ]
            },
            "tool_calls",
        ),
        {
            "id": "cmpl-stream",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "kimi-k3",
            "choices": [],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 7,
                "total_tokens": 17,
            },
        },
    ]
    stream_body = (
        "".join(f"data: {json.dumps(item)}\n\n" for item in stream_chunks)
        + "data: [DONE]\n\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=stream_body,
        )

    async def exercise():
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            model = OpenAIChatModel(
                "kimi-k3",
                provider=OpenAIProvider(
                    base_url="https://api.kimi.com/coding/v1",
                    api_key="wire-test-key",
                    http_client=http_client,
                ),
                profile=_kimi_model_profile,
            )
            params = ModelRequestParameters(
                function_tools=[
                    output_tool_definition(
                        {
                            "type": "object",
                            "required": ["summary"],
                            "properties": {"summary": {"type": "string"}},
                        }
                    )
                ],
                output_mode="text",
                output_tools=[],
                allow_text_output=True,
            )
            request = ModelRequest(parts=[UserPromptPart(content="finish")])
            async with model.request_stream(
                [request], build_model_settings(), params
            ) as streamed:
                async for _ in streamed:
                    pass
                return streamed.get()

    response = asyncio.run(exercise())

    assert captured["stream"] is True
    assert captured["stream_options"] == {"include_usage": True}
    assert captured["reasoning_effort"] == "max"
    assert captured["temperature"] == 1
    assert captured["frequency_penalty"] == 0
    assert captured["max_completion_tokens"] == 131_072
    assert "max_tokens" not in captured
    thinking = next(part for part in response.parts if isinstance(part, ThinkingPart))
    tool_call = next(part for part in response.parts if isinstance(part, ToolCallPart))
    assert thinking.content == "Think hard."
    assert tool_call.tool_name == "StructuredOutput"
    assert tool_call.args_as_dict() == {"summary": "done"}
    assert response.finish_reason == "tool_call"
    assert response.state == "complete"
    assert response.usage.input_tokens == 10
    assert response.usage.output_tokens == 7


def test_session_task_composition():
    from src.session import (
        _compose_turn_task,
        _coerce_agent_config,
        _resolve_max_iterations,
    )

    events = [
        {"type": "user.message", "content": [{"type": "text", "text": "write code"}]},
        {"type": "user.message", "content": [{"type": "text", "text": "then test it"}]},
    ]
    assert _compose_turn_task(events) == "write code\n\nthen test it"
    assert _coerce_agent_config('{"maxTurns": 7}') == {"maxTurns": 7}
    assert _resolve_max_iterations({"maxTurns": 7}) == 7
    assert _resolve_max_iterations({"maxIterations": 3}) == 3
    assert _resolve_max_iterations({}) is None
