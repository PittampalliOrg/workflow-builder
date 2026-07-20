"""session_workflow helper behavior (task composition, config coercion)."""

from __future__ import annotations

from src.agent import _coerce_agent_config, _compose_turn_task


def test_compose_turn_task_joins_text_blocks():
    events = [
        {"type": "user.message", "content": [{"type": "text", "text": "open example.com"}]},
        {"type": "user.message", "content": [{"type": "text", "text": "and screenshot it"}]},
    ]
    assert _compose_turn_task(events) == "open example.com\n\nand screenshot it"


def test_compose_turn_task_handles_confirmations():
    events = [
        {"type": "user.tool_confirmation", "tool_use_id": "t1", "result": "approve"},
    ]
    assert "tool_confirmation" in _compose_turn_task(events)
    assert "t1" in _compose_turn_task(events)


def test_coerce_agent_config():
    assert _coerce_agent_config({"modelSpec": "kimi/kimi-k3"}) == {
        "modelSpec": "kimi/kimi-k3"
    }
    assert _coerce_agent_config('{"maxTurns": 5}') == {"maxTurns": 5}
    assert _coerce_agent_config("not json") == {}
    assert _coerce_agent_config(None) == {}
