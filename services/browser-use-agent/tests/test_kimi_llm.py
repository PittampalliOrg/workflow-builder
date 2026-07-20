"""Kimi model resolution + chat-model construction."""

from __future__ import annotations

import pytest

from src.kimi_llm import build_chat_model, resolve_kimi_model


@pytest.mark.parametrize(
    ("spec", "expected"),
    [
        (None, "kimi-k3"),
        ("", "kimi-k3"),
        ("kimi/kimi-k3", "kimi-k3"),
        ("kimi-k3", "kimi-k3"),
        ("llm-kimi-k3", "kimi-k3"),
        ("kimi/kimi-k3.5", "kimi-k3.5"),
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
    assert model.base_url == "https://api.moonshot.ai/v1"
    assert model.max_completion_tokens == 32768
    assert model.api_key == "test-key"
    assert model.temperature == 1  # kimi-k3 accepts only temperature=1
    assert model.frequency_penalty == 0  # kimi-k3 accepts only 0
