"""Telemetry: activity spans, platform/OpenInference attrs, event trace-links.

Uses an in-memory exporter wired straight into the telemetry module's
globals; pydantic-ai's own InstrumentedModel internals are upstream-tested,
so `instrument_model` is patched to identity where a FakeModel is in play.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

import src.telemetry as telemetry
import src.toolsets as toolsets_mod
import src.workflow as wfmod
from src.compaction.tokens import context_usage_fields
from src.telemetry.session_tracing import get_current_trace_context
from src.workflow import call_llm, execute_tool


class FakeActivityCtx:
    workflow_id = "wf-1"
    task_id = 1


@pytest.fixture()
def otel_memory(monkeypatch):
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(telemetry, "_enabled", True)
    monkeypatch.setattr(telemetry, "_tracer_provider", provider)
    monkeypatch.setattr(telemetry, "_tracer", provider.get_tracer("test"))
    monkeypatch.setattr(telemetry, "_inbound_context", None)
    monkeypatch.setattr(wfmod, "instrument_model", lambda m: m)
    yield exporter


@pytest.fixture()
def workspace(monkeypatch, tmp_path):
    monkeypatch.setattr(toolsets_mod, "WORKSPACE_ROOT", str(tmp_path))
    toolsets_mod._ROUTERS.clear()
    yield tmp_path
    toolsets_mod._ROUTERS.clear()


def make_fake_model(responses: list):
    from pydantic_ai.messages import ModelResponse
    from pydantic_ai.usage import RequestUsage

    class FakeModel:
        model_name = "kimi-k3"

        async def request(self, messages, model_settings, model_request_parameters):
            parts = responses.pop(0)
            return ModelResponse(
                parts=parts,
                usage=RequestUsage(
                    input_tokens=120, cache_read_tokens=20, output_tokens=30
                ),
                model_name="kimi-k3",
            )

    return FakeModel()


CONTEXT = {
    "sessionId": None,  # no event POSTs from unit tests
    "workflowInstanceId": "inst-1",
    "dbExecutionId": "exec-77",
    "turnId": "turn-1",
    "turn": 1,
    "agentConfig": {},
}


def test_call_llm_emits_openinference_llm_span(monkeypatch, workspace, otel_memory):
    from pydantic_ai.messages import TextPart

    monkeypatch.setattr(
        wfmod, "build_model", lambda: make_fake_model([[TextPart(content="done")]])
    )
    out = call_llm(
        FakeActivityCtx(),
        {"task": "say done", "messages": [], "context": CONTEXT, "iteration": 0},
    )
    assert out["text"] == "done"

    spans = otel_memory.get_finished_spans()
    llm = [s for s in spans if s.name == "call_llm"]
    assert len(llm) == 1
    attrs = dict(llm[0].attributes)
    assert attrs["openinference.span.kind"] == "LLM"
    assert attrs["llm.model_name"] == "kimi-k3"
    assert attrs["llm.token_count.prompt"] == 120
    assert attrs["llm.token_count.completion"] == 30
    assert attrs["llm.token_count.total"] == 150
    assert attrs["gen_ai.usage.cache_read_input_tokens"] == 20
    assert attrs["workflow.execution.id"] == "exec-77"
    assert attrs["dapr.workflow.instance_id"] == "inst-1"
    input_messages = json.loads(attrs["llm.input_messages"])
    assert input_messages[0]["role"] == "system"
    assert any(m["role"] == "user" and "say done" in m["content"] for m in input_messages)
    output_messages = json.loads(attrs["llm.output_messages"])
    assert output_messages == [{"role": "assistant", "content": "done"}]


def test_execute_tool_emits_tool_span_with_result(workspace, otel_memory):
    out = execute_tool(
        FakeActivityCtx(),
        {
            "call": {
                "toolName": "run_command",
                "toolCallId": "tc1",
                "args": {"command": "echo hi-from-span"},
            },
            "context": CONTEXT,
            "iteration": 0,
        },
    )
    assert "hi-from-span" in json.dumps(out)

    spans = otel_memory.get_finished_spans()
    tool = [s for s in spans if s.name == "execute_tool run_command"]
    assert len(tool) == 1
    attrs = dict(tool[0].attributes)
    assert attrs["openinference.span.kind"] == "TOOL"
    assert attrs["tool.name"] == "run_command"
    assert attrs["gen_ai.tool.name"] == "run_command"
    assert attrs["gen_ai.tool.call.id"] == "tc1"
    assert json.loads(attrs["tool.arguments"]) == {"command": "echo hi-from-span"}
    assert "hi-from-span" in attrs["tool.result"]


def test_execute_tool_failure_marks_span_error(workspace, otel_memory):
    execute_tool(
        FakeActivityCtx(),
        {
            "call": {"toolName": "no_such_tool", "toolCallId": "tc2", "args": {}},
            "context": CONTEXT,
            "iteration": 0,
        },
    )
    spans = otel_memory.get_finished_spans()
    tool = [s for s in spans if s.name == "execute_tool no_such_tool"]
    assert len(tool) == 1
    assert tool[0].status.status_code.name == "ERROR"
    assert "tool.error" in dict(tool[0].attributes)


def test_activity_span_parents_on_inbound_traceparent(monkeypatch, otel_memory):
    trace_id = "0af7651916cd43dd8448eb211c80319c"
    monkeypatch.setenv(
        "WORKFLOW_BUILDER_TRACEPARENT", f"00-{trace_id}-b7ad6b7169203331-01"
    )
    monkeypatch.setattr(telemetry, "_inbound_context", None)
    with telemetry.activity_span("call_llm", {}) as span:
        assert span is not None
    finished = otel_memory.get_finished_spans()[-1]
    assert format(finished.context.trace_id, "032x") == trace_id
    assert format(finished.parent.span_id, "016x") == "b7ad6b7169203331"


def test_session_events_can_resolve_trace_context(otel_memory):
    with telemetry.activity_span("call_llm", {}):
        trace_id, span_id = get_current_trace_context()
        assert trace_id and len(trace_id) == 32
        assert span_id and len(span_id) == 16
    assert get_current_trace_context() == (None, None)


def test_disabled_telemetry_is_noop(monkeypatch):
    monkeypatch.setattr(telemetry, "_enabled", False)
    sentinel = object()
    assert telemetry.instrument_model(sentinel) is sentinel
    with telemetry.activity_span("x", {}) as span:
        assert span is None


def test_context_usage_fields_kimi_window():
    fields = context_usage_fields(
        model="kimi-k3", input_tokens=100_000, cache_read_input_tokens=50_000
    )
    assert fields["context_window_size"] == 1_048_576
    assert fields["context_input_tokens"] == 150_000
    assert fields["context_used_percentage"] == 14
    assert fields["context_remaining_percentage"] == 86
    assert fields["context_effective_window"] == 1_048_576 - 20_000
    assert (
        fields["context_auto_compact_threshold"] == 1_048_576 - 20_000 - 13_000
    )


def test_content_attr_truncation():
    class Rec:
        def __init__(self):
            self.attrs: dict[str, Any] = {}

        def set_attribute(self, key, value):
            self.attrs[key] = value

    span = Rec()
    telemetry.set_content_attr(span, "tool.result", "x" * (telemetry.MAX_CONTENT_SIZE + 5))
    assert len(span.attrs["tool.result"]) == telemetry.MAX_CONTENT_SIZE
    assert span.attrs["tool.result.truncated"] is True