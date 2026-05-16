from __future__ import annotations

import os
import sys


root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

from src.telemetry.genai_attrs import set_activity_attrs, set_genai_response_attrs  # noqa: E402


class FakeSpan:
    def __init__(self) -> None:
        self.attrs: dict[str, object] = {}

    def set_attribute(self, key: str, value: object) -> None:
        self.attrs[key] = value


def test_set_activity_attrs_stamps_workflow_and_agent_identity() -> None:
    span = FakeSpan()

    set_activity_attrs(
        span,
        workflow_id="wf_123",
        workflow_execution_id="exec_123",
        workflow_instance_id="sw-test-exec-exec_123",
        session_id="session_123",
        agent_id="agent_123",
        agent_version=7,
        agent_slug="coding-agent",
        agent_app_id="agent-runtime-coding-agent",
        component="llm-openai",
        extra={"tool.name": "read_file"},
    )

    assert span.attrs["workflow.id"] == "wf_123"
    assert span.attrs["workflow.execution.id"] == "exec_123"
    assert span.attrs["workflow.instance_id"] == "sw-test-exec-exec_123"
    assert span.attrs["session.id"] == "session_123"
    assert span.attrs["agent.id"] == "agent_123"
    assert span.attrs["agent.version"] == 7
    assert span.attrs["agent.slug"] == "coding-agent"
    assert span.attrs["agent.app_id"] == "agent-runtime-coding-agent"
    assert span.attrs["dapr.component"] == "llm-openai"
    assert span.attrs["tool.name"] == "read_file"


def test_set_genai_response_attrs_stamps_context_percentages() -> None:
    span = FakeSpan()

    set_genai_response_attrs(
        span,
        response_model="claude-sonnet-4-6",
        usage={
            "input_tokens": 80_000,
            "cache_read_input_tokens": 10_000,
            "cache_creation_input_tokens": 10_000,
        },
    )

    assert span.attrs["llm.context_window.size"] == 200_000
    assert span.attrs["llm.context.input_tokens"] == 100_000
    assert span.attrs["llm.context.used_percentage"] == 50
    assert span.attrs["llm.context.remaining_percentage"] == 50
