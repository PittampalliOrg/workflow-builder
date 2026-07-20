from __future__ import annotations

import os
import sys


root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

from src.telemetry.genai_attrs import (  # noqa: E402
    normalize_usage,
    set_activity_attrs,
    set_genai_response_attrs,
)


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
        workflow_activity_correlation_id="exec_123:node_a:0",
        session_id="session_123",
        agent_id="agent_123",
        agent_version=7,
        agent_slug="coding-agent",
        agent_app_id="agent-runtime-coding-agent",
        component="llm-openai",
        span_type="llm_request",
        extra={"tool.name": "read_file"},
    )

    assert span.attrs["workflow.id"] == "wf_123"
    assert span.attrs["workflow.execution.id"] == "exec_123"
    assert span.attrs["workflow.instance_id"] == "sw-test-exec-exec_123"
    assert span.attrs["workflow.activity.correlation_id"] == "exec_123:node_a:0"
    assert span.attrs["session.id"] == "session_123"
    assert span.attrs["agent.id"] == "agent_123"
    assert span.attrs["agent.version"] == 7
    assert span.attrs["agent.slug"] == "coding-agent"
    assert span.attrs["agent.app_id"] == "agent-runtime-coding-agent"
    assert span.attrs["dapr.component"] == "llm-openai"
    assert span.attrs["span.type"] == "llm_request"
    assert span.attrs["openinference.span.kind"] == "LLM"
    assert "mlflow.spanType" not in span.attrs
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


def test_normalize_usage_maps_kimi_cached_tokens() -> None:
    """Kimi reports prompt-cache hits as top-level `cached_tokens` in usage."""
    normalized = normalize_usage(
        {
            "prompt_tokens": 100,
            "completion_tokens": 5,
            "total_tokens": 105,
            "cached_tokens": 40,
        }
    )

    assert normalized["input_tokens"] == 100
    assert normalized["output_tokens"] == 5
    assert normalized["cache_read_input_tokens"] == 40


def test_normalize_usage_maps_deepseek_style_cache_hit() -> None:
    normalized = normalize_usage(
        {"prompt_tokens": 100, "completion_tokens": 5, "prompt_cache_hit_tokens": 30}
    )

    assert normalized["cache_read_input_tokens"] == 30


def test_set_genai_response_attrs_stamps_kimi_cache_read() -> None:
    span = FakeSpan()

    set_genai_response_attrs(
        span,
        response_model="kimi-k3",
        usage={
            "prompt_tokens": 100,
            "completion_tokens": 5,
            "cached_tokens": 40,
        },
    )

    assert span.attrs["gen_ai.usage.cache_read_input_tokens"] == 40
