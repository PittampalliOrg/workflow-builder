"""Unit tests for BrowserUseExecutor's AgentEvent stream.

A scripted fake stands in for ``browser_use.Agent`` so the tests exercise the
executor contract (event ordering, cancellation, retry-state, budgets)
without a browser or an LLM.
"""

from __future__ import annotations

from typing import Any

import pytest

from src.executor import BrowserUseExecutor, _cancellation_candidate_ids


class FakeAction:
    def __init__(self, name: str, params: dict[str, Any]):
        self._name = name
        self._params = params

    def model_dump(self, **_: Any) -> dict[str, Any]:
        return {self._name: self._params}


class FakeResult:
    def __init__(
        self,
        *,
        extracted_content: str | None = None,
        error: str | None = None,
        is_done: bool | None = None,
        success: bool | None = None,
    ):
        self.extracted_content = extracted_content
        self.error = error
        self.is_done = is_done
        self.success = success
        self.long_term_memory = None


class FakeModelOutput:
    def __init__(self, next_goal: str, actions: list[FakeAction], evaluation: str = ""):
        self.evaluation_previous_goal = evaluation
        self.next_goal = next_goal
        self.action = actions


class FakeHistoryItem:
    def __init__(self, model_output: FakeModelOutput | None, results: list[FakeResult]):
        self.model_output = model_output
        self.result = results


class FakeHistoryList:
    def __init__(self):
        self.history: list[FakeHistoryItem] = []
        self.usage = None

    def final_result(self) -> str | None:
        for item in reversed(self.history):
            for result in item.result:
                if result.is_done and result.extracted_content:
                    return result.extracted_content
        return None

    def is_successful(self) -> bool | None:
        for item in reversed(self.history):
            for result in item.result:
                if result.is_done:
                    return bool(result.success)
        return None


class FakeState:
    def __init__(self):
        self.n_steps = 1

    def model_dump(self, **_: Any) -> dict[str, Any]:
        return {"n_steps": self.n_steps}


class FakeAgent:
    """Scripted browser-use Agent: each entry is (history_item, is_done)."""

    def __init__(self, script: list[tuple[FakeHistoryItem, bool]]):
        self.script = list(script)
        self.history = FakeHistoryList()
        self.state = FakeState()
        self.closed = False
        self.steps_taken = 0

    async def take_step(self, step_info: Any = None) -> tuple[bool, bool]:
        self.steps_taken += 1
        self.state.n_steps += 1
        if not self.script:
            return False, True
        item, is_done = self.script.pop(0)
        self.history.history.append(item)
        return is_done, True

    async def close(self) -> None:
        self.closed = True


def make_factory(agent: FakeAgent, calls: list[dict[str, Any]] | None = None):
    def factory(**kwargs: Any) -> FakeAgent:
        if calls is not None:
            calls.append(kwargs)
        return agent

    return factory


def two_step_script() -> list[tuple[FakeHistoryItem, bool]]:
    step1 = FakeHistoryItem(
        FakeModelOutput(
            "Open the target page",
            [FakeAction("navigate", {"url": "https://example.com"})],
            evaluation="Starting fresh",
        ),
        [FakeResult(extracted_content="navigated")],
    )
    step2 = FakeHistoryItem(
        FakeModelOutput("Finish up", [FakeAction("done", {"text": "All done"})]),
        [FakeResult(extracted_content="All done", is_done=True, success=True)],
    )
    return [(step1, False), (step2, True)]


async def collect(gen):
    return [event async for event in gen]


async def test_full_run_event_sequence():
    agent = FakeAgent(two_step_script())
    executor = BrowserUseExecutor(
        agent_factory=make_factory(agent), cancellation_reader=lambda _s: None
    )
    events = await collect(
        executor.run("do the task", session_id="s1", context={"turn": 1})
    )

    types = [event.type for event in events]
    assert types == [
        "message",
        "tool_call",
        "tool_result",
        "session",
        "message",
        "tool_call",
        "tool_result",
        "session",
        "complete",
    ]
    final = events[-1].content
    assert final["role"] == "assistant"
    assert final["success"] is True
    assert final["is_done"] is True
    assert "All done" in final["content"]
    assert agent.closed is True

    first_call = events[1].content
    assert first_call["name"] == "navigate"
    assert first_call["arguments"] == {"url": "https://example.com"}
    first_result = events[2].content
    assert first_result["tool_call_id"] == first_call["id"]
    assert first_result["result"]["extracted_content"] == "navigated"


async def test_cancellation_short_circuits():
    agent = FakeAgent(two_step_script())
    executor = BrowserUseExecutor(
        agent_factory=make_factory(agent),
        cancellation_reader=lambda _s: {"type": "session.terminate", "reason": "stop"},
    )
    events = await collect(
        executor.run(
            "do the task",
            session_id="s1",
            context={"cancellationScopeId": "wf__turn__1"},
        )
    )
    assert [event.type for event in events] == ["complete"]
    final = events[0].content
    assert final["cancelled"] is True
    assert final["success"] is False
    assert final["stop_reason"]["type"] == "terminated"
    assert agent.steps_taken == 0
    assert agent.closed is True


async def test_error_yields_error_event_and_closes():
    class ExplodingAgent(FakeAgent):
        async def take_step(self, step_info: Any = None) -> tuple[bool, bool]:
            raise RuntimeError("CDP connection lost")

    agent = ExplodingAgent([])
    executor = BrowserUseExecutor(
        agent_factory=make_factory(agent), cancellation_reader=lambda _s: None
    )
    events = await collect(executor.run("task", session_id="s1"))
    assert events[-1].type == "error"
    assert "CDP connection lost" in str(events[-1].content)
    assert agent.closed is True


async def test_factory_failure_yields_error():
    def broken_factory(**_: Any):
        raise RuntimeError("KIMI_API_KEY missing")

    executor = BrowserUseExecutor(
        agent_factory=broken_factory, cancellation_reader=lambda _s: None
    )
    events = await collect(executor.run("task", session_id="s1"))
    assert [event.type for event in events] == ["error"]


async def test_step_budget_from_agent_config():
    agent = FakeAgent([])  # never done
    executor = BrowserUseExecutor(
        agent_factory=make_factory(agent), cancellation_reader=lambda _s: None
    )
    events = await collect(
        executor.run(
            "task", session_id="s1", context={"agentConfig": {"maxTurns": 2}}
        )
    )
    assert agent.steps_taken == 2
    final = events[-1]
    assert final.type == "complete"
    assert final.content["is_done"] is False
    assert "step budget" in final.content["content"]


async def test_retry_reinjects_saved_state():
    calls: list[dict[str, Any]] = []
    agent = FakeAgent(two_step_script())
    executor = BrowserUseExecutor(
        agent_factory=make_factory(agent, calls), cancellation_reader=lambda _s: None
    )
    await collect(executor.run("task", session_id="s1"))
    assert calls[0]["injected_state"] is None
    assert await executor.get_session("s1") is not None

    agent2 = FakeAgent(two_step_script())
    executor._agent_factory = make_factory(agent2, calls)
    await collect(executor.run("task", session_id="s1"))
    assert calls[1]["injected_state"] is agent.state


async def test_get_session_unknown_returns_none():
    executor = BrowserUseExecutor(
        agent_factory=make_factory(FakeAgent([])), cancellation_reader=lambda _s: None
    )
    assert await executor.get_session("nope") is None


def test_cancellation_candidate_ids_strip_turn_suffixes():
    assert _cancellation_candidate_ids("sesn_x__turn__3") == ["sesn_x__turn__3", "sesn_x"]
    assert _cancellation_candidate_ids("sesn_x:turn-2") == ["sesn_x:turn-2", "sesn_x"]
    assert _cancellation_candidate_ids("sesn_x") == ["sesn_x"]
    assert _cancellation_candidate_ids("") == []
