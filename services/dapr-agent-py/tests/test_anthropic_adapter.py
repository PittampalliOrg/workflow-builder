from __future__ import annotations

import importlib
import os
import sys
import types

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

adapter = importlib.import_module("src.anthropic_adapter")


def test_anthropic_normalizer_forwards_system_messages() -> None:
    system, messages = adapter._normalize_messages_for_anthropic(
        None,
        [
            {"role": "system", "content": "System one"},
            {"role": "assistant", "content": "Prior assistant"},
            {"role": "system", "content": [{"type": "text", "text": "System two"}]},
            {"role": "user", "content": "Current user"},
        ],
    )

    assert system == "System one\n\nSystem two"
    assert messages == [
        {"role": "assistant", "content": "Prior assistant"},
        {"role": "user", "content": "Current user"},
    ]


def test_anthropic_normalizer_preserves_tool_result_shape() -> None:
    system, messages = adapter._normalize_messages_for_anthropic(
        None,
        [
            {"role": "system", "content": "System"},
            {
                "role": "tool",
                "content": "Tool output",
                "tool_call_id": "toolu_smoke",
            },
        ],
    )

    assert system == "System"
    assert messages == [
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_smoke",
                    "content": "Tool output",
                }
            ],
        }
    ]


def test_anthropic_normalizer_sanitizes_foreign_tool_call_ids() -> None:
    _system, messages = adapter._normalize_messages_for_anthropic(
        None,
        [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "Grep:5",
                        "function": {"name": "Grep", "arguments": '{"pattern":"x"}'},
                    }
                ],
            },
            {
                "role": "tool",
                "content": "match",
                "tool_call_id": "Grep:5",
            },
        ],
    )

    assert messages[0]["content"][0]["id"] == "Grep_5"
    assert messages[1]["content"][0]["tool_use_id"] == "Grep_5"


def test_anthropic_sdk_requires_api_key(monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    try:
        adapter._call_anthropic_sdk(
            "llm-anthropic-sonnet",
            [{"role": "user", "content": "hello"}],
        )
    except RuntimeError as exc:
        assert (
            str(exc) == "No Anthropic authentication configured. Set ANTHROPIC_API_KEY."
        )
    else:
        raise AssertionError("Expected missing ANTHROPIC_API_KEY to raise RuntimeError")


def _fake_anthropic_response() -> types.SimpleNamespace:
    return types.SimpleNamespace(
        content=[types.SimpleNamespace(type="text", text="done")],
        stop_reason="end_turn",
        usage=types.SimpleNamespace(
            input_tokens=12,
            output_tokens=4,
            cache_read_input_tokens=3,
            cache_creation_input_tokens=2,
        ),
    )


def test_anthropic_sdk_emits_explicit_otel_llm_span(monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setitem(
        sys.modules,
        "anthropic",
        types.SimpleNamespace(Anthropic=lambda **_kwargs: types.SimpleNamespace()),
    )
    monkeypatch.setattr(
        adapter,
        "_stream_final_message",
        lambda _client, **_kwargs: _fake_anthropic_response(),
    )

    telemetry = importlib.import_module("src.telemetry")
    span = object()
    started: list[tuple[tuple[object, ...], dict[str, object]]] = []
    ended: list[tuple[tuple[object, ...], dict[str, object]]] = []
    monkeypatch.setattr(
        telemetry,
        "start_llm_request_span",
        lambda *args, **kwargs: started.append((args, kwargs)) or span,
    )
    monkeypatch.setattr(
        telemetry,
        "end_llm_request_span",
        lambda *args, **kwargs: ended.append((args, kwargs)),
    )

    result = adapter._call_anthropic_sdk(
        "llm-anthropic-sonnet",
        [{"role": "user", "content": "hello"}],
    )

    assert result["content"] == "done"
    assert started[0][0] == ("claude-sonnet-4-6",)
    assert started[0][1]["query_source"] == "dapr_agent_py.anthropic_adapter"
    assert ended[0][0] == (span,)
    assert ended[0][1] == {
        "input_tokens": 12,
        "output_tokens": 4,
        "cache_read_tokens": 3,
        "cache_creation_tokens": 2,
        "success": True,
        "error": None,
        "has_tool_call": False,
        "ttft_ms": ended[0][1]["ttft_ms"],
        "model_output": "done",
        "thinking_output": None,
    }


def test_anthropic_sdk_ends_otel_llm_span_on_provider_error(monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setitem(
        sys.modules,
        "anthropic",
        types.SimpleNamespace(Anthropic=lambda **_kwargs: types.SimpleNamespace()),
    )

    def fail_request(_client, **_kwargs):
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(adapter, "_stream_final_message", fail_request)
    telemetry = importlib.import_module("src.telemetry")
    span = object()
    ended: list[tuple[tuple[object, ...], dict[str, object]]] = []
    monkeypatch.setattr(telemetry, "start_llm_request_span", lambda *_a, **_k: span)
    monkeypatch.setattr(
        telemetry,
        "end_llm_request_span",
        lambda *args, **kwargs: ended.append((args, kwargs)),
    )

    try:
        adapter._call_anthropic_sdk(
            "llm-anthropic-sonnet",
            [{"role": "user", "content": "hello"}],
        )
    except RuntimeError as exc:
        assert str(exc) == "provider unavailable"
    else:
        raise AssertionError("Expected provider failure to propagate")

    assert ended[0][0] == (span,)
    assert ended[0][1]["success"] is False
    assert ended[0][1]["error"] == "provider unavailable"


def test_anthropic_sdk_ends_otel_llm_span_on_recovery_error(monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setitem(
        sys.modules,
        "anthropic",
        types.SimpleNamespace(Anthropic=lambda **_kwargs: types.SimpleNamespace()),
    )
    truncated = _fake_anthropic_response()
    truncated.stop_reason = "max_tokens"
    responses = iter((truncated, RuntimeError("recovery unavailable")))

    def request_sequence(_client, **_kwargs):
        result = next(responses)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(adapter, "_stream_final_message", request_sequence)
    telemetry = importlib.import_module("src.telemetry")
    span = object()
    ended: list[tuple[tuple[object, ...], dict[str, object]]] = []
    monkeypatch.setattr(telemetry, "start_llm_request_span", lambda *_a, **_k: span)
    monkeypatch.setattr(
        telemetry,
        "end_llm_request_span",
        lambda *args, **kwargs: ended.append((args, kwargs)),
    )

    try:
        adapter._call_anthropic_sdk(
            "llm-anthropic-sonnet",
            [{"role": "user", "content": "hello"}],
            max_tokens=adapter.ESCALATED_MAX_TOKENS,
        )
    except RuntimeError as exc:
        assert str(exc) == "recovery unavailable"
    else:
        raise AssertionError("Expected recovery failure to propagate")

    assert len(ended) == 1
    assert ended[0][0] == (span,)
    assert ended[0][1]["success"] is False
    assert ended[0][1]["error"] == "recovery unavailable"


# ---------------------------------------------------------------------------
# StructuredOutput TOOL mode: per-request tool definition (input_schema format).
# ---------------------------------------------------------------------------
def test_with_structured_output_tool_appends_input_schema_definition() -> None:
    schema = {
        "type": "object",
        "required": ["ok"],
        "properties": {"ok": {"type": "boolean"}},
    }
    tools = adapter._with_structured_output_tool(
        [{"name": "Read", "description": "r", "input_schema": {"type": "object"}}],
        schema,
    )
    names = [t["name"] for t in tools]
    assert names == sorted(names)
    assert "StructuredOutput" in names and "Read" in names
    so = next(t for t in tools if t["name"] == "StructuredOutput")
    assert so["input_schema"] == schema
    # Anthropic format: no OpenAI function envelope
    assert "function" not in so


def test_with_structured_output_tool_replaces_same_named_entry() -> None:
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    fake = {
        "name": "StructuredOutput",
        "description": "fake",
        "input_schema": {"type": "object"},
    }
    tools = adapter._with_structured_output_tool([fake], schema)
    assert len(tools) == 1
    assert tools[0]["input_schema"] == schema
