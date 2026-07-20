"""Kimi model construction + settings (pydantic-ai model classes)."""

from __future__ import annotations

import pytest

from src.workflow import build_model, build_model_settings


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


def test_model_settings_enforce_kimi_contract():
    settings = build_model_settings()
    assert settings["temperature"] == 1
    assert settings["frequency_penalty"] == 0
    assert settings["extra_body"] == {"reasoning_effort": "max"}
    assert settings["timeout"] > 0


def test_session_task_composition():
    from src.session import _compose_turn_task, _coerce_agent_config, _resolve_max_iterations

    events = [
        {"type": "user.message", "content": [{"type": "text", "text": "write code"}]},
        {"type": "user.message", "content": [{"type": "text", "text": "then test it"}]},
    ]
    assert _compose_turn_task(events) == "write code\n\nthen test it"
    assert _coerce_agent_config('{"maxTurns": 7}') == {"maxTurns": 7}
    assert _resolve_max_iterations({"maxTurns": 7}) == 7
    assert _resolve_max_iterations({"maxIterations": 3}) == 3
    assert _resolve_max_iterations({}) is None
