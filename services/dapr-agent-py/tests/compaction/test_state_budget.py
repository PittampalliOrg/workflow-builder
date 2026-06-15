"""Tests for the pre-save state byte-budget guard (plan 1a).

Exercises the over-budget path: the guard offloads oldest oversized message
bodies, asserts the persisted document drops under budget, and asserts a
`state_size` telemetry field is emitted. Runs without Dapr (FakeAgent +
captured telemetry sink), mirroring tests/compaction/test_engine.py.
"""
from __future__ import annotations

from types import SimpleNamespace

from src.compaction.state_budget import (
    GRPC_HARD_CEILING_BYTES,
    StateBudgetConfig,
    enforce_state_budget,
    enforce_state_byte_budget,
    resolve_state_budget_config,
    serialized_state_bytes,
    _OFFLOAD_MARKER_PREFIX,
)


# --- FakeAgent (same shape as tests/compaction/test_engine.py) --------------


class _FakeInfra:
    def __init__(self, messages):
        self.entry = SimpleNamespace(messages=list(messages))

    def get_state(self, instance_id):  # noqa: ARG002
        return self.entry


class _FakeAgent:
    def __init__(self, messages):
        self._infra = _FakeInfra(messages)
        self._save_calls = 0

    def save_state(self, instance_id):  # noqa: ARG002
        self._save_calls += 1


def _small_cfg(budget_bytes: int) -> StateBudgetConfig:
    return StateBudgetConfig(
        enabled=True,
        budget_bytes=budget_bytes,
        hard_ceiling_bytes=GRPC_HARD_CEILING_BYTES,
        preserve_last_n=2,
        min_offload_bytes=512,
        head_preview_chars=64,
    )


def _huge_assistant(n_bytes: int):
    return {"role": "assistant", "content": "y" * n_bytes}


# --- pure enforce_state_budget ----------------------------------------------


def test_under_budget_is_noop():
    msgs = [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hi"}]
    result = enforce_state_budget(msgs, config=_small_cfg(budget_bytes=10_000))
    assert result.over_budget is False
    assert result.reason == "under_budget"
    assert result.offloaded_count == 0
    assert result.messages is msgs  # unchanged, identity preserved
    assert result.state_size == result.post_bytes == serialized_state_bytes(msgs)


def test_over_budget_offloads_until_under_budget():
    budget = 50_000
    # Two huge OLD bodies (each ~200KB) + a small recent tail (preserved).
    msgs = [
        _huge_assistant(200_000),
        _huge_assistant(200_000),
        {"role": "user", "content": "recent question"},
        {"role": "assistant", "content": "recent answer"},
    ]
    pre = serialized_state_bytes(msgs)
    assert pre > budget

    result = enforce_state_budget(msgs, config=_small_cfg(budget_bytes=budget))

    assert result.over_budget is True
    assert result.offloaded_count >= 1
    assert result.reason == "offloaded"
    # The persisted document is now under budget.
    assert serialized_state_bytes(result.messages) <= budget
    assert result.post_bytes <= budget
    assert result.state_size == result.post_bytes
    # Oldest body was offloaded (head preview + marker), recent tail untouched.
    assert _OFFLOAD_MARKER_PREFIX in result.messages[0]["content"]
    assert result.messages[-1] == {"role": "assistant", "content": "recent answer"}
    assert result.messages[-2] == {"role": "user", "content": "recent question"}


def test_offload_is_pairing_safe_tool_use_untouched():
    budget = 20_000
    msgs = [
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "z" * 100_000},
                {"type": "tool_use", "id": "tu-1", "name": "bash", "input": {"cmd": "ls"}},
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "tu-1",
            "content": [{"type": "tool_result", "content": "ok"}],
        },
        {"role": "user", "content": "next"},
        {"role": "assistant", "content": "done"},
    ]
    result = enforce_state_budget(msgs, config=_small_cfg(budget_bytes=budget))
    assert result.over_budget is True
    assert serialized_state_bytes(result.messages) <= budget
    # The text block was shrunk; the tool_use block is byte-for-byte intact so
    # tool_use/tool_result pairing survives.
    blocks = result.messages[0]["content"]
    text_block = next(b for b in blocks if b.get("type") == "text")
    tool_use_block = next(b for b in blocks if b.get("type") == "tool_use")
    assert _OFFLOAD_MARKER_PREFIX in text_block["text"]
    assert tool_use_block == {
        "type": "tool_use",
        "id": "tu-1",
        "name": "bash",
        "input": {"cmd": "ls"},
    }


def test_offload_is_idempotent():
    budget = 50_000
    msgs = [_huge_assistant(300_000), {"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]
    first = enforce_state_budget(msgs, config=_small_cfg(budget_bytes=budget))
    assert first.over_budget is True
    # Feed the already-offloaded output back in: now under budget -> no-op.
    second = enforce_state_budget(first.messages, config=_small_cfg(budget_bytes=budget))
    assert second.over_budget is False
    assert second.offloaded_count == 0


def test_offload_sink_embeds_ref():
    budget = 10_000
    captured = []

    def _sink(text: str) -> str:
        captured.append(len(text))
        return "file_abc123"

    msgs = [_huge_assistant(100_000), {"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]
    result = enforce_state_budget(msgs, config=_small_cfg(budget_bytes=budget), offload=_sink)
    assert result.over_budget is True
    assert captured  # sink was invoked with the original body
    assert "ref=file_abc123" in result.messages[0]["content"]


# --- activity-side orchestration (FakeAgent + telemetry capture) ------------


def test_enforce_state_byte_budget_persists_and_emits_state_size():
    budget = 40_000
    msgs = [_huge_assistant(250_000), _huge_assistant(250_000), {"role": "user", "content": "now"}, {"role": "assistant", "content": "ok"}]
    agent = _FakeAgent(msgs)
    cfg = _small_cfg(budget_bytes=budget)

    emitted = []

    def _emit(session_id, instance_id, result, config):  # noqa: ARG001
        emitted.append((session_id, instance_id, result, config))

    result = enforce_state_byte_budget(
        agent,
        instance_id="inst-1",
        session_id="sess-1",
        config=cfg,
        emit=_emit,
    )

    # Over-budget path: state was reduced and persisted exactly once.
    assert result.over_budget is True
    assert agent._save_calls == 1
    assert serialized_state_bytes(agent._infra.entry.messages) <= budget
    # state_size telemetry was emitted with the post-guard byte size.
    assert len(emitted) == 1
    _sess, _inst, _res, _cfg = emitted[0]
    assert _sess == "sess-1" and _inst == "inst-1"
    assert _res.state_size == result.post_bytes
    assert _res.to_dict()["stateSizeBytes"] == result.post_bytes


def test_enforce_state_byte_budget_under_budget_emits_but_no_save():
    msgs = [{"role": "user", "content": "small"}, {"role": "assistant", "content": "tiny"}]
    agent = _FakeAgent(msgs)
    emitted = []
    result = enforce_state_byte_budget(
        agent,
        instance_id="inst-2",
        session_id="sess-2",
        config=_small_cfg(budget_bytes=1_000_000),
        emit=lambda *a: emitted.append(a),
    )
    assert result.over_budget is False
    assert agent._save_calls == 0  # nothing to persist
    assert len(emitted) == 1  # state_size still observable on the common path


def test_resolve_state_budget_clamps_to_hard_ceiling(monkeypatch):
    monkeypatch.setenv("DAPR_AGENT_PY_STATE_BYTE_BUDGET", str(64 * 1024 * 1024))
    monkeypatch.setenv("DAPR_AGENT_PY_STATE_BYTE_HARD_CEILING", str(GRPC_HARD_CEILING_BYTES))
    cfg = resolve_state_budget_config()
    # A budget above the gRPC hard ceiling is clamped down so the guard can
    # actually protect the channel.
    assert cfg.budget_bytes == GRPC_HARD_CEILING_BYTES


def test_disabled_via_env(monkeypatch):
    monkeypatch.setenv("DAPR_AGENT_PY_STATE_BYTE_GUARD_ENABLED", "false")
    cfg = resolve_state_budget_config()
    assert cfg.enabled is False
    big = [_huge_assistant(500_000)]
    result = enforce_state_budget(big, config=cfg)
    assert result.over_budget is False
    assert result.reason == "disabled"
