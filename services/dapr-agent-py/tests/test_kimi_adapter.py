from __future__ import annotations

import importlib
from io import BytesIO
import json
import os
import sys
from types import SimpleNamespace
from urllib.error import HTTPError

from pydantic import BaseModel
import pytest

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

adapter = importlib.import_module("src.kimi_adapter")
formulas = importlib.import_module("src.kimi_formulas")


@pytest.fixture(autouse=True)
def _disable_kimi_formula_tools(monkeypatch):
    """Keep these chat-completions tests hermetic: no /formulas traffic through
    the mocked urlopen. Formula behavior is covered in test_kimi_formulas.py."""
    monkeypatch.setenv("KIMI_FORMULAS", "")
    formulas.reset_formula_cache()
    yield
    formulas.reset_formula_cache()


class _Response:
    def __init__(self, payload: dict):
        self.payload = payload
        choices = payload.get("choices") or []
        choice = choices[0] if choices else {}
        message = dict(choice.get("message") or {})
        tool_calls = message.get("tool_calls")
        if isinstance(tool_calls, list):
            message["tool_calls"] = [
                {"index": index, **tool_call}
                for index, tool_call in enumerate(tool_calls)
            ]
        chunk = {
            "id": payload.get("id"),
            "object": "chat.completion.chunk",
            "model": payload.get("model", "kimi-k3"),
            "choices": [
                {
                    "index": 0,
                    "delta": message,
                    "finish_reason": choice.get("finish_reason"),
                    "usage": payload.get("usage"),
                }
            ],
        }
        self.lines = [
            f"data: {json.dumps(chunk)}\n".encode(),
            b"\n",
            b"data: [DONE]\n",
            b"\n",
        ]

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode()

    def readline(self) -> bytes:
        return self.lines.pop(0) if self.lines else b""


class _RawSseResponse:
    def __init__(self, lines: list[bytes | BaseException]):
        self.lines = list(lines)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def readline(self) -> bytes:
        if not self.lines:
            return b""
        item = self.lines.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def _sse_event(payload: dict | str) -> list[bytes]:
    serialized = payload if isinstance(payload, str) else json.dumps(payload)
    return [f"data: {serialized}\n".encode(), b"\n"]


def test_kimi_auth_headers_require_api_key(monkeypatch) -> None:
    monkeypatch.delenv("KIMI_API_KEY", raising=False)
    monkeypatch.setenv("MOONSHOT_API_KEY", "legacy-key-must-not-be-used")

    try:
        adapter._auth_headers()
    except RuntimeError as exc:
        assert str(exc) == "No Kimi authentication configured. Set KIMI_API_KEY."
    else:
        raise AssertionError("Expected missing KIMI_API_KEY to raise RuntimeError")


def test_kimi_auth_headers_use_kimi_api_key(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")

    headers, auth_mode = adapter._auth_headers()

    assert headers["Authorization"] == "Bearer kimi-test"
    assert auth_mode == "kimi-api-key"


def test_kimi_model_fallback_is_pinned_to_k3(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_DEFAULT_MODEL", "kimi-k2.6")

    assert adapter._get_kimi_model("unmapped-kimi-component") == "kimi-k3"


def test_kimi_k3_chat_uses_openai_compatible_endpoint_and_max_reasoning(
    monkeypatch,
) -> None:
    bodies: list[dict] = []
    auth_headers: list[str] = []
    accept_headers: list[str | None] = []
    user_agents: list[str | None] = []
    urls: list[str] = []
    timeouts: list[float] = []

    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    monkeypatch.delenv("KIMI_BASE_URL", raising=False)
    monkeypatch.delenv("KIMI_CHAT_COMPLETIONS_URL", raising=False)
    monkeypatch.delenv("KIMI_STREAM_IDLE_TIMEOUT_SECONDS", raising=False)

    def urlopen(req, timeout: int):
        urls.append(req.full_url)
        auth_headers.append(req.headers["Authorization"])
        accept_headers.append(req.get_header("Accept"))
        user_agents.append(req.get_header("User-agent"))
        bodies.append(json.loads(req.data.decode()))
        timeouts.append(timeout)
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "reasoning_content": "reasoning",
                            "content": "ok",
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2},
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "hello"}],
    )

    assert urls == ["https://api.kimi.com/coding/v1/chat/completions"]
    assert timeouts == [900.0]
    assert auth_headers == ["Bearer kimi-test"]
    assert accept_headers == ["text/event-stream"]
    assert user_agents == ["workflow-builder-dapr-agent-py/1.0"]
    assert bodies[0]["model"] == "kimi-k3"
    assert bodies[0]["messages"] == [{"role": "user", "content": "hello"}]
    assert bodies[0]["reasoning_effort"] == "max"
    assert "thinking" not in bodies[0]
    assert bodies[0]["max_completion_tokens"] == 131072
    assert "max_tokens" not in bodies[0]
    assert "prompt_cache_key" not in bodies[0]
    assert bodies[0]["stream"] is True
    assert bodies[0]["stream_options"] == {"include_usage": True}
    assert result["content"] == "ok"
    assert result["reasoning_content"] == "reasoning"
    assert result["metadata"]["provider"] == "kimi-chat"


def test_reasoning_effort_resolver_clamps_to_max_with_warning(caplog) -> None:
    # kimi-k3 currently accepts only "max"; every other level clamps with a
    # warning (the per-agent config path is live for when lower levels ship).
    import logging

    with caplog.at_level(logging.WARNING, logger="src.kimi_adapter"):
        assert adapter._reasoning_effort("low") == "max"
        assert adapter._reasoning_effort("high") == "max"
        assert adapter._reasoning_effort("xhigh") == "max"
        assert adapter._reasoning_effort(None) == "max"  # env default
        assert adapter._reasoning_effort("max") == "max"
    warnings = [r.getMessage() for r in caplog.records if "clamping" in r.getMessage()]
    assert len(warnings) == 3  # low, high, xhigh — none for env-default or max


def test_apply_kimi_output_mode_uses_per_agent_effort_override(caplog) -> None:
    # The per-agent override (agentConfig.reasoningEffort, stamped by call_llm)
    # wins over the env and clamps to the supported value without raising.
    import logging

    body: dict = {}
    with caplog.at_level(logging.WARNING, logger="src.kimi_adapter"):
        adapter._apply_kimi_output_mode(body, reasoning_effort="low")
    assert body["reasoning_effort"] == "max"
    assert any("clamping" in r.getMessage() for r in caplog.records)


def test_kimi_sse_accumulates_reasoning_content_and_content(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    lines = [
        *_sse_event(
            {
                "id": "chatcmpl_stream",
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "role": "assistant",
                            "reasoning_content": "Inspect ",
                        },
                        "finish_reason": None,
                    }
                ],
            }
        ),
        *_sse_event(
            {
                "id": "chatcmpl_stream",
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"reasoning_content": "carefully."},
                        "finish_reason": None,
                    }
                ],
            }
        ),
        *_sse_event(
            {
                "id": "chatcmpl_stream",
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": "All "},
                        "finish_reason": None,
                    }
                ],
            }
        ),
        *_sse_event(
            {
                "id": "chatcmpl_stream",
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": "done."},
                        "finish_reason": None,
                    }
                ],
            }
        ),
        *_sse_event(
            {
                "id": "chatcmpl_stream",
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "delta": {},
                        "finish_reason": "stop",
                        "usage": {
                            "prompt_tokens": 10,
                            "completion_tokens": 20,
                            "total_tokens": 30,
                        },
                    }
                ],
            }
        ),
        *_sse_event("[DONE]"),
    ]
    monkeypatch.setattr(
        adapter.urllib.request,
        "urlopen",
        lambda req, timeout: _RawSseResponse(lines),
    )

    result = adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "Inspect the result."}],
    )

    assert result["reasoning_content"] == "Inspect carefully."
    assert result["content"] == "All done."
    assert result["metadata"]["finish_reason"] == "stop"
    assert result["metadata"]["usage"] == {
        "prompt_tokens": 10,
        "completion_tokens": 20,
        "total_tokens": 30,
    }


def test_kimi_sse_publishes_coalesced_nonterminal_deltas(monkeypatch) -> None:
    published: list[tuple[str, dict, str | None]] = []
    publisher = importlib.import_module("src.event_publisher")
    monkeypatch.setattr(adapter, "_STREAM_DELTAS_ENABLED", True)
    monkeypatch.setattr(adapter, "_DELTA_COALESCE_MS", 60_000)
    monkeypatch.setattr(adapter, "_DELTA_COALESCE_BYTES", 1_000_000)
    monkeypatch.setattr(adapter, "_publish_llm_usage", lambda **kwargs: None)
    monkeypatch.setattr(
        publisher,
        "get_scoped_session",
        lambda: ("session-kimi", "instance-kimi"),
    )
    monkeypatch.setattr(
        publisher,
        "publish_session_event",
        lambda session_id, event_type, data, instance_id=None: published.append(
            (event_type, data, instance_id)
        ),
    )
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    lines = [
        *_sse_event(
            {
                "id": "chatcmpl_deltas",
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"reasoning_content": "Think "},
                        "finish_reason": None,
                    }
                ],
            }
        ),
        *_sse_event(
            {
                "id": "chatcmpl_deltas",
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"reasoning_content": "carefully."},
                        "finish_reason": None,
                    }
                ],
            }
        ),
        *_sse_event(
            {
                "id": "chatcmpl_deltas",
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": "Answer "},
                        "finish_reason": None,
                    }
                ],
            }
        ),
        *_sse_event(
            {
                "id": "chatcmpl_deltas",
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": "ready."},
                        "finish_reason": None,
                    }
                ],
            }
        ),
        *_sse_event(
            {
                "id": "chatcmpl_deltas",
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "delta": {},
                        "finish_reason": "stop",
                    }
                ],
            }
        ),
        *_sse_event("[DONE]"),
    ]
    monkeypatch.setattr(
        adapter.urllib.request,
        "urlopen",
        lambda req, timeout: _RawSseResponse(lines),
    )

    result = adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "hello"}],
    )

    assert result["reasoning_content"] == "Think carefully."
    assert result["content"] == "Answer ready."
    assert published == [
        (
            "agent.thinking_delta",
            {
                "content_block_index": 0,
                "text": "Think carefully.",
                "cumulative_len": 16,
            },
            "instance-kimi",
        ),
        (
            "agent.message_delta",
            {
                "content_block_index": 1,
                "text": "Answer ready.",
                "cumulative_len": 13,
            },
            "instance-kimi",
        ),
    ]
    assert not any(event_type == "agent.message" for event_type, _, _ in published)


def test_kimi_stream_deltas_are_opt_in(monkeypatch) -> None:
    monkeypatch.delenv("DAPR_AGENT_PY_STREAM_DELTAS", raising=False)
    assert adapter._stream_deltas_enabled() is False

    monkeypatch.setenv("DAPR_AGENT_PY_STREAM_DELTAS", "true")
    assert adapter._stream_deltas_enabled() is True


def test_kimi_stream_delta_emitter_is_inert_when_disabled(monkeypatch) -> None:
    monkeypatch.setattr(adapter, "_STREAM_DELTAS_ENABLED", False)
    emitter = adapter._KimiStreamDeltaEmitter()

    emitter.append("agent.message_delta", 0, "partial")
    emitter.flush_all()

    assert emitter._publish is None
    assert emitter._buffers == {}


def test_kimi_sse_accumulates_indexed_tool_call_fragments(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    lines = [
        *_sse_event(
            {
                "id": "chatcmpl_tools",
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "reasoning_content": "I need both files.",
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call_0",
                                    "type": "function",
                                    "function": {
                                        "name": "read_file",
                                        "arguments": '{"path":"',
                                    },
                                },
                                {
                                    "index": 1,
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {
                                        "name": "read_file",
                                        "arguments": '{"path":"',
                                    },
                                },
                            ],
                        },
                        "finish_reason": None,
                    }
                ],
            }
        ),
        *_sse_event(
            {
                "id": "chatcmpl_tools",
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 1,
                                    "function": {"arguments": 'README.md"}'},
                                },
                                {
                                    "index": 0,
                                    "function": {"arguments": 'main.py"}'},
                                },
                            ]
                        },
                        "finish_reason": None,
                    }
                ],
            }
        ),
        *_sse_event(
            {
                "id": "chatcmpl_tools",
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "delta": {},
                        "finish_reason": "tool_calls",
                    }
                ],
            }
        ),
        *_sse_event("[DONE]"),
    ]
    monkeypatch.setattr(
        adapter.urllib.request,
        "urlopen",
        lambda req, timeout: _RawSseResponse(lines),
    )

    result = adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "Read the files."}],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
    )

    assert result["reasoning_content"] == "I need both files."
    assert result["metadata"]["finish_reason"] == "tool_calls"
    assert result["tool_calls"] == [
        {
            "id": "call_0",
            "type": "function",
            "function": {
                "name": "read_file",
                "arguments": '{"path":"main.py"}',
            },
        },
        {
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "read_file",
                "arguments": '{"path":"README.md"}',
            },
        },
    ]


def test_kimi_sse_requires_done_even_after_finish_reason(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    lines = _sse_event(
        {
            "id": "chatcmpl_incomplete",
            "model": "kimi-k3",
            "choices": [
                {
                    "index": 0,
                    "delta": {"content": "partial"},
                    "finish_reason": "stop",
                }
            ],
        }
    )
    monkeypatch.setattr(
        adapter.urllib.request,
        "urlopen",
        lambda req, timeout: _RawSseResponse(lines),
    )

    with pytest.raises(RuntimeError, match=r"before the required data: \[DONE\]"):
        adapter._call_kimi_chat(
            "llm-kimi-k3",
            [{"role": "user", "content": "hello"}],
        )


def test_kimi_sse_preserves_multiline_data_continuations(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    lines = [
        b"event: ignored-before-data\n",
        b"\n",
        b'data: {"id":"chatcmpl_multiline",\n',
        b'"model":"kimi-k3",\n',
        b'"choices":[{"index":0,"delta":{"content":"ok"},\n',
        b'"finish_reason":"stop","usage":{"total_tokens":3}}]}\n',
        b"\n",
        *_sse_event("[DONE]"),
    ]
    monkeypatch.setattr(
        adapter.urllib.request,
        "urlopen",
        lambda req, timeout: _RawSseResponse(lines),
    )

    result = adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "hello"}],
    )

    assert result["content"] == "ok"
    assert result["metadata"]["finish_reason"] == "stop"
    assert result["metadata"]["usage"] == {"total_tokens": 3}


def test_kimi_sse_surfaces_provider_error_event(monkeypatch) -> None:
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    lines = [
        *_sse_event(
            {
                "error": {
                    "type": "server_error",
                    "message": "upstream generation failed",
                }
            }
        ),
        *_sse_event("[DONE]"),
    ]
    monkeypatch.setattr(
        adapter.urllib.request,
        "urlopen",
        lambda req, timeout: _RawSseResponse(lines),
    )

    with pytest.raises(
        RuntimeError,
        match="Kimi Chat API stream failed: upstream generation failed",
    ):
        adapter._call_kimi_chat(
            "llm-kimi-k3",
            [{"role": "user", "content": "hello"}],
        )


def test_kimi_sse_uses_per_read_idle_timeout(monkeypatch) -> None:
    observed_timeouts: list[float] = []
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    monkeypatch.setenv("KIMI_STREAM_IDLE_TIMEOUT_SECONDS", "42.5")

    def urlopen(req, timeout: float):
        observed_timeouts.append(timeout)
        return _RawSseResponse([b": keep-alive\n", b"\n", TimeoutError()])

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    with pytest.raises(
        TimeoutError,
        match="Kimi SSE stream was idle for 42.5 seconds before completion",
    ):
        adapter._call_kimi_chat(
            "llm-kimi-k3",
            [{"role": "user", "content": "hello"}],
        )

    assert observed_timeouts == [42.5]


def test_kimi_component_map_only_contains_k3() -> None:
    assert adapter.COMPONENT_MODEL_MAP == {"llm-kimi-k3": "kimi-k3"}


def test_kimi_normalizer_preserves_supported_inline_vision_parts() -> None:
    messages = adapter._normalize_messages_for_kimi(
        None,
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Inspect this UI"},
                    {
                        "type": "input_image",
                        "image_url": "data:image/png;base64,AAAA",
                    },
                ],
            }
        ],
    )

    assert messages == [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Inspect this UI"},
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,AAAA"},
                },
            ],
        }
    ]


def test_kimi_normalizer_moves_mcp_screenshot_after_linked_tool_result() -> None:
    messages = adapter._normalize_messages_for_kimi(
        None,
        [
            {"role": "user", "content": "Judge the rendered page."},
            {
                "role": "assistant",
                "content": "",
                "reasoning_content": "I need visual evidence.",
                "tool_calls": [
                    {
                        "id": "shot_1",
                        "type": "function",
                        "function": {
                            "name": "browser_agent_browser_screenshot",
                            "arguments": "{}",
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "shot_1",
                "content": [
                    {"type": "text", "text": "Screenshot captured"},
                    {
                        "type": "image",
                        "data": "BBBB",
                        "mimeType": "image/jpeg",
                    },
                ],
            },
        ],
    )

    assert messages[1]["reasoning_content"] == "I need visual evidence."
    assert messages[2] == {
        "role": "tool",
        "tool_call_id": "shot_1",
        "content": "Screenshot captured",
    }
    assert messages[3] == {
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": "Visual media returned by a tool (most recent last):",
            },
            {
                "type": "image_url",
                "image_url": {"url": "data:image/jpeg;base64,BBBB"},
            },
        ],
    }


def test_kimi_normalizer_does_not_forward_public_or_unsupported_images() -> None:
    messages = adapter._normalize_messages_for_kimi(
        None,
        [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": "https://example.com/page.png"},
                    },
                    {
                        "type": "image",
                        "data": "CCCC",
                        "mimeType": "image/svg+xml",
                    },
                ],
            }
        ],
    )

    content = messages[0]["content"]
    assert isinstance(content, list)
    serialized = json.dumps(content)
    assert "base64 or ms://" in serialized
    assert "example.com" not in serialized


def test_kimi_normalizer_preserves_k3_video_file_reference() -> None:
    messages = adapter._normalize_messages_for_kimi(
        None,
        [
            {
                "role": "user",
                "content": [
                    {
                        "type": "video_url",
                        "video_url": {"url": "ms://file_kimi_demo"},
                    },
                    {"type": "text", "text": "Review the interaction flow."},
                ],
            }
        ],
    )

    assert messages == [
        {
            "role": "user",
            "content": [
                {
                    "type": "video_url",
                    "video_url": {"url": "ms://file_kimi_demo"},
                },
                {"type": "text", "text": "Review the interaction flow."},
            ],
        }
    ]


def test_kimi_normalizer_rejects_base64_video_input() -> None:
    messages = adapter._normalize_messages_for_kimi(
        None,
        [
            {
                "role": "user",
                "content": [
                    {
                        "type": "video_url",
                        "video_url": "data:video/mp4;base64,AAAA",
                    }
                ],
            }
        ],
    )

    assert "uploaded ms:// video" in json.dumps(messages)
    assert "AAAA" not in json.dumps(messages)


def test_kimi_chat_http_body_keeps_vision_content_as_an_array(monkeypatch) -> None:
    bodies: list[dict] = []
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response(
            {
                "id": "chatcmpl_vision",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "visible"},
                        "finish_reason": "stop",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)
    messages = adapter._normalize_messages_for_kimi(
        None,
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Inspect the layout."},
                    {
                        "type": "image",
                        "data": "DDDD",
                        "mimeType": "image/png",
                    },
                ],
            }
        ],
    )

    adapter._call_kimi_chat("llm-kimi-k3", messages)

    content = bodies[0]["messages"][0]["content"]
    assert isinstance(content, list)
    assert content[1] == {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64,DDDD"},
    }


def test_kimi_chat_accepts_dict_tool_choice(monkeypatch) -> None:
    bodies: list[dict] = []
    tool_choice = {"type": "function", "function": {"name": "read_file"}}

    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "read"}],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a file",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
        tool_choice=tool_choice,
    )

    assert bodies[0]["tool_choice"] == tool_choice
    assert bodies[0]["tools"][0]["function"]["strict"] is False
    assert bodies[0]["reasoning_effort"] == "max"
    assert "thinking" not in bodies[0]


def test_kimi_chat_accepts_none_tool_choice(monkeypatch) -> None:
    bodies: list[dict] = []

    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "read"}],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a file",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
        tool_choice="none",
    )

    assert bodies[0]["tools"][0]["function"]["name"] == "read_file"
    assert bodies[0]["tool_choice"] == "none"
    assert bodies[0]["reasoning_effort"] == "max"
    assert "thinking" not in bodies[0]


def test_kimi_structured_output_uses_strict_json_schema_and_max_reasoning(
    monkeypatch,
) -> None:
    bodies: list[dict] = []

    class ConversationSummary(BaseModel):
        summary: str
        items: list[dict]

    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": '{"summary":"ok","items":[]}',
                        },
                        "finish_reason": "stop",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "summarize"}],
        response_format=ConversationSummary,
    )

    assert bodies[0]["messages"][0] == {
        "role": "system",
        "content": "Return a valid JSON object only.",
    }
    assert bodies[0]["messages"][1] == {"role": "user", "content": "summarize"}
    assert bodies[0]["response_format"]["type"] == "json_schema"
    assert bodies[0]["response_format"]["json_schema"]["name"] == "ConversationSummary"
    assert bodies[0]["response_format"]["json_schema"]["strict"] is True
    schema = bodies[0]["response_format"]["json_schema"]["schema"]
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == {"summary", "items"}
    assert bodies[0]["reasoning_effort"] == "max"
    assert "thinking" not in bodies[0]
    parsed = adapter.parse_structured_response(ConversationSummary, result["content"])
    assert parsed.summary == "ok"


def test_kimi_dynamic_script_schema_uses_native_strict_json_schema(monkeypatch) -> None:
    bodies: list[dict] = []
    schema = {
        "type": "object",
        "properties": {"ok": {"type": "boolean"}},
    }
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": '{"ok":true}'},
                        "finish_reason": "stop",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "return status"}],
        native_json_schema=schema,
    )

    response_format = bodies[0]["response_format"]
    assert response_format["type"] == "json_schema"
    assert response_format["json_schema"]["name"] == "structured_output"
    assert response_format["json_schema"]["strict"] is True
    assert response_format["json_schema"]["schema"] == {
        "type": "object",
        "properties": {"ok": {"type": "boolean"}},
        "required": ["ok"],
        "additionalProperties": False,
    }
    assert bodies[0]["reasoning_effort"] == "max"
    assert "thinking" not in bodies[0]


def test_kimi_structured_output_tool_composes_with_normal_tools(monkeypatch) -> None:
    bodies: list[dict] = []
    schema = {
        "type": "object",
        "required": ["ok"],
        "properties": {"ok": {"type": "boolean"}},
    }
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "tool_calls": [
                                {
                                    "id": "call_structured",
                                    "type": "function",
                                    "function": {
                                        "name": "StructuredOutput",
                                        "arguments": '{"ok":true}',
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "inspect, then return status"}],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a file",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
        native_json_schema=schema,
        structured_output_tool=True,
    )

    body = bodies[0]
    tools_by_name = {
        tool["function"]["name"]: tool["function"] for tool in body["tools"]
    }
    assert set(tools_by_name) == {"StructuredOutput", "read_file"}
    assert tools_by_name["StructuredOutput"]["parameters"] == schema
    assert tools_by_name["StructuredOutput"]["strict"] is False
    assert body["messages"] == [
        {"role": "user", "content": "inspect, then return status"}
    ]
    assert body["tool_choice"] == "auto"
    assert body["reasoning_effort"] == "max"
    assert body["stream"] is True
    assert "response_format" not in body


def test_kimi_patch_forwards_structured_output_tool_mode(monkeypatch) -> None:
    from dapr_agents.llm.dapr.chat import DaprChatClient

    captured: dict = {}
    original_generate = DaprChatClient.generate
    missing = object()
    original_marker = getattr(DaprChatClient, "_kimi_patched", missing)

    def call_kimi(component, messages, **kwargs):
        captured.update({"component": component, "messages": messages, **kwargs})
        return {
            "content": '{"ok":true}',
            "reasoning_content": "done",
            "tool_calls": [],
            "metadata": {"model": "kimi-k3"},
        }

    monkeypatch.setattr(adapter, "_call_kimi_chat", call_kimi)
    monkeypatch.setattr(adapter, "_build_kimi_chat_response", lambda **kwargs: kwargs)

    try:
        DaprChatClient._kimi_patched = False
        adapter.patch_for_kimi(None)
        client = SimpleNamespace(
            _llm_component="llm-kimi-k3",
            _response_json_schema={
                "type": "object",
                "properties": {"ok": {"type": "boolean"}},
            },
            _structured_output_mode="tool",
        )

        response = DaprChatClient.generate(client, prompt="Return status")

        assert captured["component"] == "llm-kimi-k3"
        assert captured["native_json_schema"] == client._response_json_schema
        assert captured["structured_output_tool"] is True
        assert response["content"] == '{"ok":true}'
    finally:
        DaprChatClient.generate = original_generate
        if original_marker is missing:
            delattr(DaprChatClient, "_kimi_patched")
        else:
            DaprChatClient._kimi_patched = original_marker


def test_kimi_structured_output_tool_replaces_duplicate_and_sorts() -> None:
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}}
    tools = adapter._with_structured_output_tool(
        [
            {
                "type": "function",
                "function": {
                    "name": "zebra",
                    "description": "Last",
                    "parameters": {"type": "object"},
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "StructuredOutput",
                    "description": "stale",
                    "parameters": {"type": "object"},
                },
            },
        ],
        schema,
    )

    assert [tool["function"]["name"] for tool in tools] == [
        "StructuredOutput",
        "zebra",
    ]
    assert tools[0]["function"]["parameters"] == schema
    assert tools[0]["function"]["description"] != "stale"


def test_kimi_structured_output_tool_from_empty_toolset() -> None:
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}}

    tools = adapter._with_structured_output_tool(None, schema)

    assert [tool["function"]["name"] for tool in tools] == ["StructuredOutput"]
    assert tools[0]["function"]["parameters"] == schema
    assert tools[0]["function"]["strict"] is False


def test_kimi_non_object_schema_does_not_enter_tool_mode(monkeypatch) -> None:
    bodies: list[dict] = []
    schema = {"type": "array", "items": {"type": "string"}}
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "[]"},
                        "finish_reason": "stop",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "return an array"}],
        native_json_schema=schema,
        structured_output_tool=True,
    )

    assert "tools" not in bodies[0]
    assert bodies[0]["response_format"]["type"] == "json_schema"
    assert bodies[0]["messages"][0]["role"] == "system"
    assert "JSON" in bodies[0]["messages"][0]["content"]


def test_kimi_structured_tool_preserves_screenshot_pixels(monkeypatch) -> None:
    bodies: list[dict] = []
    schema = {
        "type": "object",
        "required": ["observation"],
        "properties": {"observation": {"type": "string"}},
    }
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    messages = adapter._normalize_messages_for_kimi(
        None,
        [
            {"role": "user", "content": "Inspect the page."},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "shot_1",
                        "type": "function",
                        "function": {
                            "name": "browser_agent_browser_screenshot",
                            "arguments": "{}",
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "shot_1",
                "content": [
                    {"type": "text", "text": "Screenshot captured"},
                    {"type": "image", "data": "PIXELS", "mimeType": "image/png"},
                ],
            },
        ],
    )

    def urlopen(req, timeout: int):
        bodies.append(json.loads(req.data.decode()))
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "tool_calls": [
                                {
                                    "id": "structured_1",
                                    "type": "function",
                                    "function": {
                                        "name": "StructuredOutput",
                                        "arguments": '{"observation":"visible"}',
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    adapter._call_kimi_chat(
        "llm-kimi-k3",
        messages,
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "browser_agent_browser_screenshot",
                    "description": "Capture a screenshot",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
        native_json_schema=schema,
        structured_output_tool=True,
    )

    body = bodies[0]
    assert body["messages"][2] == {
        "role": "tool",
        "tool_call_id": "shot_1",
        "content": "Screenshot captured",
    }
    assert body["messages"][3]["content"][1] == {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64,PIXELS"},
    }
    assert {
        tool["function"]["name"] for tool in body["tools"]
    } == {"StructuredOutput", "browser_agent_browser_screenshot"}
    assert "response_format" not in body


def test_kimi_chat_retries_429_with_retry_after_ms(monkeypatch) -> None:
    calls = 0
    sleeps: list[float] = []

    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    monkeypatch.setenv("KIMI_RATE_LIMIT_MAX_RETRIES", "1")
    monkeypatch.setattr(adapter.time, "sleep", lambda value: sleeps.append(value))

    def urlopen(req, timeout: int):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise HTTPError(
                req.full_url,
                429,
                "rate limited",
                {"Retry-After-Ms": "250"},
                BytesIO(b'{"error":{"message":"rate limited"}}'),
            )
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "hello"}],
    )

    assert calls == 2
    assert sleeps == [0.25]
    assert result["content"] == "ok"


def test_kimi_chat_retries_429_with_fallback_backoff(monkeypatch) -> None:
    calls = 0
    sleeps: list[float] = []

    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    monkeypatch.setenv("KIMI_RATE_LIMIT_MAX_RETRIES", "1")
    monkeypatch.setenv("KIMI_RATE_LIMIT_BACKOFF_SECONDS", "0.5")
    monkeypatch.setattr(adapter.time, "sleep", lambda value: sleeps.append(value))

    def urlopen(req, timeout: int):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise HTTPError(
                req.full_url,
                429,
                "rate limited",
                {},
                BytesIO(b'{"error":{"message":"rate limited"}}'),
            )
        return _Response(
            {
                "id": "chatcmpl_test",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
            }
        )

    monkeypatch.setattr(adapter.urllib.request, "urlopen", urlopen)

    result = adapter._call_kimi_chat(
        "llm-kimi-k3",
        [{"role": "user", "content": "hello"}],
    )

    assert calls == 2
    assert sleeps == [0.5]
    assert result["content"] == "ok"


def test_kimi_tool_call_response_is_normalized() -> None:
    content, tool_calls, finish_reason, reasoning = adapter._extract_kimi_response(
        {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": None,
                        "reasoning_content": "I should read the file.",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "read_file",
                                    "arguments": '{"path":"README.md"}',
                                },
                            }
                        ],
                    },
                }
            ]
        }
    )

    assert content == ""
    assert finish_reason == "tool_calls"
    assert reasoning == "I should read the file."
    assert tool_calls == [
        {
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "read_file",
                "arguments": '{"path":"README.md"}',
            },
        }
    ]


def test_kimi_k3_reasoning_and_tool_calls_survive_durable_history_replay() -> None:
    tool_calls = [
        {
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "read_file",
                "arguments": '{"path":"README.md"}',
            },
        }
    ]
    response = adapter._build_kimi_chat_response(
        content="",
        reasoning_content="I should read the file.",
        tool_calls=tool_calls,
        metadata={"model": "kimi-k3"},
    )

    stored = response.get_message().model_dump()
    assert stored["content"] == ""
    assert stored["reasoning_content"] == "I should read the file."
    assert stored["tool_calls"] == tool_calls

    replay = adapter._normalize_messages_for_kimi(
        None,
        [
            {"role": "user", "content": "Read the file."},
            stored,
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": "file contents",
            },
        ],
    )
    assert replay[1] == {
        "role": "assistant",
        "content": None,
        "reasoning_content": "I should read the file.",
        "tool_calls": tool_calls,
    }


def test_kimi_reasoning_state_schema_round_trips_reasoning_content() -> None:
    from dapr_agents.agents.configs import DEFAULT_AGENT_WORKFLOW_BUNDLE

    adapter.install_kimi_reasoning_state_schema()
    message = adapter.coerce_kimi_reasoning_message(
        {
            "role": "assistant",
            "content": "",
            "reasoning_content": "durable reasoning",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": "{}"},
                }
            ],
        }
    )
    entry = DEFAULT_AGENT_WORKFLOW_BUNDLE.entry_model_cls(
        messages=[message],
        last_message=message,
    )

    restored = DEFAULT_AGENT_WORKFLOW_BUNDLE.entry_model_cls.model_validate(
        entry.model_dump()
    )
    assert restored.messages[0].reasoning_content == "durable reasoning"
    assert restored.last_message.reasoning_content == "durable reasoning"


def test_kimi_normalizer_collapses_invalid_tool_history() -> None:
    messages = adapter._normalize_messages_for_kimi(
        None,
        [
            {"role": "system", "content": "System"},
            {"role": "user", "content": "Read file"},
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": "file contents",
            },
            {"role": "user", "content": "continue"},
        ],
    )

    assert messages[0] == {"role": "system", "content": "System"}
    assert messages[1]["role"] == "user"
    assert "tool-call ordering was invalid" in messages[1]["content"]
    assert "[tool] file contents" in messages[1]["content"]


def test_kimi_publish_llm_usage_maps_cached_tokens(monkeypatch) -> None:
    """Kimi's top-level cached_tokens lands in cache_read_input_tokens, and
    input_tokens is netted (prompt_tokens minus cache hits) — the Session
    Pulse llm_usage schema shared with the other provider adapters."""
    import src.event_publisher as event_publisher

    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        event_publisher, "get_scoped_session", lambda: ("sess-1", "inst-1")
    )
    monkeypatch.setattr(event_publisher, "get_scoped_audit_fields", lambda: {})
    monkeypatch.setattr(
        event_publisher,
        "publish_session_event",
        lambda sid, event_type, payload, **kwargs: events.append(
            (event_type, payload)
        ),
    )

    adapter._publish_llm_usage(
        model="kimi-k3",
        usage={
            "prompt_tokens": 100,
            "completion_tokens": 5,
            "total_tokens": 105,
            "cached_tokens": 40,
        },
        ttft_ms=12.0,
        duration_ms=34.0,
        success=True,
    )

    assert len(events) == 1
    event_type, payload = events[0]
    assert event_type == "agent.llm_usage"
    assert payload["input_tokens"] == 60
    assert payload["output_tokens"] == 5
    assert payload["cache_read_input_tokens"] == 40
    assert payload["cache_creation_input_tokens"] == 0
    assert payload["success"] is True


def test_kimi_sse_captures_usage_only_trailing_chunk(monkeypatch) -> None:
    """With stream_options.include_usage, Kimi sends a final usage chunk with
    empty choices; the reader must capture its cached_tokens."""
    import src.event_publisher as event_publisher

    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        event_publisher, "get_scoped_session", lambda: ("sess-1", "inst-1")
    )
    monkeypatch.setattr(event_publisher, "get_scoped_audit_fields", lambda: {})
    monkeypatch.setattr(
        event_publisher,
        "publish_session_event",
        lambda sid, event_type, payload, **kwargs: events.append(
            (event_type, payload)
        ),
    )

    lines = [
        *_sse_event(
            {
                "id": "chatcmpl_usage",
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": None,
            }
        ),
        *_sse_event(
            {
                "id": "chatcmpl_usage",
                "model": "kimi-k3",
                "choices": [],
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 5,
                    "total_tokens": 105,
                    "cached_tokens": 40,
                },
            }
        ),
        b"data: [DONE]\n",
        b"\n",
    ]
    monkeypatch.setattr(
        adapter.urllib.request,
        "urlopen",
        lambda req, timeout: _RawSseResponse(lines),
    )

    result = adapter._call_kimi_chat(
        "llm-kimi-k3", [{"role": "user", "content": "hello"}]
    )

    assert result["content"] == "ok"
    assert result["metadata"]["usage"]["cached_tokens"] == 40
    llm_usage = [p for t, p in events if t == "agent.llm_usage"]
    assert llm_usage[-1]["cache_read_input_tokens"] == 40
    assert llm_usage[-1]["input_tokens"] == 60


def test_kimi_span_records_cache_read_tokens(monkeypatch) -> None:
    import src.telemetry as telemetry

    monkeypatch.setenv("KIMI_API_KEY", "kimi-test")
    end_kwargs: list[dict] = []
    recorded: list[dict] = []
    monkeypatch.setattr(
        telemetry, "start_llm_request_span", lambda *a, **k: object()
    )
    monkeypatch.setattr(
        telemetry,
        "end_llm_request_span",
        lambda span, **kwargs: end_kwargs.append(kwargs),
    )
    monkeypatch.setattr(
        telemetry,
        "record_tokens",
        lambda **kwargs: recorded.append(kwargs),
    )

    lines = [
        *_sse_event(
            {
                "id": "chatcmpl_cache",
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 5,
                    "total_tokens": 105,
                    "cached_tokens": 40,
                },
            }
        ),
        b"data: [DONE]\n",
        b"\n",
    ]
    monkeypatch.setattr(
        adapter.urllib.request,
        "urlopen",
        lambda req, timeout: _RawSseResponse(lines),
    )

    adapter._call_kimi_chat("llm-kimi-k3", [{"role": "user", "content": "hello"}])

    assert end_kwargs[0]["cache_read_tokens"] == 40
    cache_records = [r for r in recorded if r["type_"] == "cacheRead"]
    assert cache_records[0]["count"] == 40
