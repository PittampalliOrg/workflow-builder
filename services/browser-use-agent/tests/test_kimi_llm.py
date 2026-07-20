"""Kimi model resolution + chat-model construction."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from browser_use.llm.messages import (
    ContentPartImageParam,
    ContentPartTextParam,
    ImageURL,
    UserMessage,
)
from src.kimi_llm import build_chat_model, resolve_kimi_model


@pytest.mark.parametrize(
    ("spec", "expected"),
    [
        (None, "kimi-k3"),
        ("", "kimi-k3"),
        ("kimi/kimi-k3", "kimi-k3"),
        ("kimi-k3", "kimi-k3"),
        ("llm-kimi-k3", "kimi-k3"),
        ("kimi/kimi-k3.5", "kimi-k3"),
        ("kimi/kimi-k2.6", "kimi-k3"),
        ("openai/gpt-5.5", "kimi-k3"),  # non-Kimi provider falls back (P1)
        ("zai/glm-5.2", "kimi-k3"),
    ],
)
def test_resolve_kimi_model(spec, expected):
    cfg = {"modelSpec": spec} if spec is not None else None
    assert resolve_kimi_model(cfg) == expected


def test_build_chat_model_requires_api_key(monkeypatch):
    monkeypatch.delenv("KIMI_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="KIMI_API_KEY"):
        build_chat_model({})


def test_build_chat_model_defaults(monkeypatch):
    monkeypatch.setenv("KIMI_API_KEY", "test-key")
    model = build_chat_model({"modelSpec": "kimi/kimi-k3"})
    assert model.model == "kimi-k3"
    assert model.base_url == "https://api.kimi.com/coding/v1"
    assert model.max_completion_tokens == 32768
    assert model.api_key == "test-key"
    assert model.temperature == 1  # kimi-k3 accepts only temperature=1
    assert model.frequency_penalty == 0  # kimi-k3 accepts only 0
    assert model.reasoning_effort == "max"
    assert model.reasoning_models == ["kimi-k3"]


@pytest.mark.asyncio
async def test_kimi_request_sends_max_reasoning_and_native_image_parts(monkeypatch):
    monkeypatch.setenv("KIMI_API_KEY", "test-key")
    model = build_chat_model({"modelSpec": "kimi/kimi-k3"})
    captured: dict = {}

    class _Completions:
        async def create(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content="done"),
                        finish_reason="stop",
                    )
                ],
                usage=None,
            )

    client = SimpleNamespace(
        chat=SimpleNamespace(completions=_Completions()),
    )
    monkeypatch.setattr(model, "get_client", lambda: client)

    await model.ainvoke(
        [
            UserMessage(
                content=[
                    ContentPartImageParam(
                        image_url=ImageURL(
                            url="data:image/png;base64,REAL_PIXEL_BYTES"
                        )
                    ),
                    ContentPartTextParam(text="Inspect this screenshot"),
                ]
            )
        ]
    )

    assert captured["reasoning_effort"] == "max"
    assert "temperature" not in captured
    assert "frequency_penalty" not in captured
    assert captured["messages"][0]["content"][0] == {
        "type": "image_url",
        "image_url": {
            "url": "data:image/png;base64,REAL_PIXEL_BYTES",
            "detail": "auto",
        },
    }
