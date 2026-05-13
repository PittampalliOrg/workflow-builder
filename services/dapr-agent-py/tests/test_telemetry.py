"""Unit tests for src/telemetry.

Uses in-memory span/metric/log exporters so tests run without an OTLP
collector. Asserts span hierarchy (claude_code.interaction ▸ tool ▸
tool.execution, and llm_request under interaction), attribute presence,
and metric counter increments — the minimum that proves the TS port
emits the names and shapes external dashboards expect.
"""

from __future__ import annotations

import os
import sys
import types

root = os.path.join(os.path.dirname(__file__), "..")
if root not in sys.path:
    sys.path.insert(0, root)

import pytest  # noqa: E402

# OTEL allows set_tracer_provider/set_meter_provider only once per process.
# Install providers at session scope; reset the exporter/reader between tests.


@pytest.fixture(scope="session")
def _session_providers():
    from opentelemetry import metrics as _metrics_api
    from opentelemetry import trace as _trace_api
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import InMemoryMetricReader
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
        InMemorySpanExporter,
    )
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor

    from src.telemetry import providers as providers_module

    resource = Resource.create({"service.name": "dapr-agent-py-test"})

    exporter = InMemorySpanExporter()
    tp = TracerProvider(resource=resource)
    tp.add_span_processor(SimpleSpanProcessor(exporter))
    _trace_api.set_tracer_provider(tp)

    metric_reader = InMemoryMetricReader()
    mp = MeterProvider(resource=resource, metric_readers=[metric_reader])
    _metrics_api.set_meter_provider(mp)

    providers_module._tracer_provider = tp
    providers_module._meter_provider = mp
    providers_module._logger_provider = None
    providers_module._event_logger = None
    providers_module._ready = True

    from src.telemetry.metrics import init_metrics

    init_metrics()
    return exporter, metric_reader


@pytest.fixture
def telemetry_with_in_memory(_session_providers):
    exporter, metric_reader = _session_providers
    exporter.clear()
    # Note: InMemoryMetricReader snapshots per call; tests read it after they write.
    return exporter, metric_reader


def _span_names(exporter):
    return [s.name for s in exporter.get_finished_spans()]


def _find_span(exporter, name):
    for s in exporter.get_finished_spans():
        if s.name == name:
            return s
    return None


def test_span_hierarchy_and_attributes(telemetry_with_in_memory, monkeypatch):
    exporter, _ = telemetry_with_in_memory
    monkeypatch.delenv("OTEL_LOG_USER_PROMPTS", raising=False)
    from src.telemetry import (
        end_interaction_span,
        end_llm_request_span,
        end_tool_execution_span,
        end_tool_span,
        set_session_context,
        start_interaction_span,
        start_llm_request_span,
        start_tool_execution_span,
        start_tool_span,
    )

    set_session_context(
        instance_id="wf-abc",
        execution_id="exec-1",
        workflow_id="workflow-1",
        workflow_node_id="node-1",
        workflow_node_name="Solve",
        agent_id="agent-1",
        agent_version=3,
        agent_slug="agent-slug",
        agent_app_id="agent-runtime-agent-slug",
        sandbox_name="sandbox-1",
        workspace_ref="ws_abc",
        dapr_component="llm-anthropic",
        mlflow_model_id="m-agent-v1",
        mlflow_model_uri="models:/m-agent-v1",
        mlflow_experiment_id="11",
        mlflow_run_id="run_1",
        mlflow_parent_run_id="parent_run_1",
        workflow_trace_group_id="exec-1",
    )
    start_interaction_span("hello world")
    llm = start_llm_request_span(
        "claude-opus-4-7",
        fast_mode=False,
        query_source="test",
    )
    end_llm_request_span(
        llm,
        input_tokens=100,
        output_tokens=50,
        cache_read_tokens=10,
        ttft_ms=250.0,
        success=True,
        has_tool_call=False,
    )
    start_tool_span("Edit", tool_attributes={"tool.call_id": "tc-1"})
    exec_span = start_tool_execution_span()
    end_tool_execution_span(exec_span, success=True)
    end_tool_span(result_tokens=42)
    end_interaction_span()

    names = _span_names(exporter)
    assert "claude_code.interaction" in names
    assert "claude_code.llm_request" in names
    assert "claude_code.tool" in names
    assert "claude_code.tool.execution" in names

    interaction = _find_span(exporter, "claude_code.interaction")
    assert interaction.attributes["user_prompt_length"] == 11
    assert interaction.attributes["span.type"] == "interaction"
    assert interaction.attributes["session.id"] == "wf-abc"
    assert interaction.attributes["workflow.execution.id"] == "exec-1"
    assert interaction.attributes["workflow.id"] == "workflow-1"
    assert interaction.attributes["workflow.node.id"] == "node-1"
    assert interaction.attributes["workflow.node.name"] == "Solve"
    assert interaction.attributes["agent.id"] == "agent-1"
    assert interaction.attributes["agent.version"] == 3
    assert interaction.attributes["agent.slug"] == "agent-slug"
    assert interaction.attributes["agent.app_id"] == "agent-runtime-agent-slug"
    assert interaction.attributes["sandbox.name"] == "sandbox-1"
    assert interaction.attributes["sandbox.workspace_ref"] == "ws_abc"
    assert interaction.attributes["dapr.component"] == "llm-anthropic"
    assert interaction.attributes["mlflow.modelId"] == "m-agent-v1"
    assert interaction.attributes["mlflow.model.uri"] == "models:/m-agent-v1"
    assert interaction.attributes["agent.mlflow_uri"] == "models:/m-agent-v1"
    assert interaction.attributes["mlflow.experiment_id"] == "11"
    assert interaction.attributes["mlflow.run_id"] == "run_1"
    assert interaction.attributes["mlflow.parent_run_id"] == "parent_run_1"
    assert interaction.attributes["workflow_builder.trace_group_id"] == "exec-1"
    assert interaction.attributes["mlflow.spanType"] == "AGENT"
    # Prompt redacted by default (OTEL_LOG_USER_PROMPTS unset).
    assert interaction.attributes["user_prompt"] == "<REDACTED>"

    llm_span = _find_span(exporter, "claude_code.llm_request")
    assert llm_span.attributes["model"] == "claude-opus-4-7"
    assert llm_span.attributes["input_tokens"] == 100
    assert llm_span.attributes["output_tokens"] == 50
    assert llm_span.attributes["cache_read_tokens"] == 10
    assert llm_span.attributes["ttft_ms"] == 250.0
    assert llm_span.attributes["success"] is True
    assert llm_span.attributes["llm_request.context"] == "interaction"
    assert llm_span.attributes["query_source"] == "test"
    assert llm_span.attributes["mlflow.spanType"] == "CHAT_MODEL"
    # llm_request should be a child of interaction.
    assert llm_span.parent is not None
    assert llm_span.parent.span_id == interaction.context.span_id

    tool_span = _find_span(exporter, "claude_code.tool")
    assert tool_span.attributes["tool_name"] == "Edit"
    assert tool_span.attributes["tool.call_id"] == "tc-1"
    assert tool_span.attributes["mlflow.spanType"] == "TOOL"
    assert tool_span.parent.span_id == interaction.context.span_id

    exec_span_out = _find_span(exporter, "claude_code.tool.execution")
    assert exec_span_out.attributes["success"] is True
    assert exec_span_out.attributes["mlflow.spanType"] == "TOOL"
    assert exec_span_out.parent.span_id == tool_span.context.span_id


def test_user_prompt_logged_when_env_truthy(telemetry_with_in_memory, monkeypatch):
    exporter, _ = telemetry_with_in_memory
    monkeypatch.setenv("OTEL_LOG_USER_PROMPTS", "1")

    from src.telemetry import end_interaction_span, start_interaction_span

    start_interaction_span("top secret prompt")
    end_interaction_span()

    interaction = _find_span(exporter, "claude_code.interaction")
    assert interaction.attributes["user_prompt"] == "top secret prompt"


def test_metric_counters(telemetry_with_in_memory):
    _, reader = telemetry_with_in_memory
    from src.telemetry import (
        record_code_edit_decision,
        record_cost,
        record_session_start,
        record_tokens,
        set_session_context,
    )

    set_session_context(instance_id="wf-1")
    record_session_start()
    record_tokens(type_="input", count=100, model="claude-opus-4-7")
    record_tokens(type_="output", count=50, model="claude-opus-4-7")
    record_cost(cost_usd=0.015, model="claude-opus-4-7")
    record_code_edit_decision(decision="accept", tool="Edit")

    data = reader.get_metrics_data()
    names = []
    for rm in data.resource_metrics:
        for sm in rm.scope_metrics:
            for metric in sm.metrics:
                names.append(metric.name)
    assert "claude_code.session.count" in names
    assert "claude_code.token.usage" in names
    assert "claude_code.cost.usage" in names
    assert "claude_code.code_edit_tool.decision" in names


def test_dapr_agents_context_bridge_stamps_runtime_identity():
    from src.telemetry.attributes import reset_session_context, set_session_context
    from src.telemetry.providers import _iter_context_bridge_attrs

    token = set_session_context(
        instance_id="wf-tool",
        execution_id="exec-tool",
        workflow_id="workflow-tool",
        workflow_node_id="agent-node",
        workflow_node_name="Agent Node",
        agent_id="agent-tool",
        agent_version="5",
        agent_slug="agent-tool-slug",
        agent_app_id="agent-runtime-tool",
        sandbox_name="sandbox-tool",
        workspace_ref="workspace-tool",
        dapr_component="llm-tool",
        mlflow_model_id="m-agent-tool",
        mlflow_model_uri="models:/m-agent-tool",
    )
    try:
        attrs = dict(_iter_context_bridge_attrs(lambda: iter([("session.id", "oi-session")])))
    finally:
        reset_session_context(token)

    assert attrs["session.id"] == "wf-tool"
    assert attrs["workflow.execution.id"] == "exec-tool"
    assert attrs["workflow.id"] == "workflow-tool"
    assert attrs["workflow.node.id"] == "agent-node"
    assert attrs["workflow.node.name"] == "Agent Node"
    assert attrs["agent.id"] == "agent-tool"
    assert attrs["agent.version"] == "5"
    assert attrs["agent.slug"] == "agent-tool-slug"
    assert attrs["agent.app_id"] == "agent-runtime-tool"
    assert attrs["sandbox.name"] == "sandbox-tool"
    assert attrs["sandbox.workspace_ref"] == "workspace-tool"
    assert attrs["dapr.component"] == "llm-tool"
    assert attrs["mlflow.modelId"] == "m-agent-tool"
    assert attrs["mlflow.model.uri"] == "models:/m-agent-tool"
    assert attrs["agent.mlflow_uri"] == "models:/m-agent-tool"


def test_dapr_agents_context_bridge_drops_null_attributes():
    from src.telemetry.attributes import reset_session_context, set_session_context
    from src.telemetry.providers import _iter_context_bridge_attrs

    token = set_session_context(instance_id="wf-tool")
    try:
        attrs = dict(
            _iter_context_bridge_attrs(
                lambda: iter(
                    [
                        ("span_type", None),
                        ("openinference.span.kind", "TOOL"),
                    ]
                )
            )
        )
    finally:
        reset_session_context(token)

    assert attrs["session.id"] == "wf-tool"
    assert attrs["openinference.span.kind"] == "TOOL"
    assert "span_type" not in attrs


def test_context_local_mlflow_destination_uses_trace_experiment(monkeypatch):
    calls = {}

    class FakeMlflowExperimentLocation:
        def __init__(self, experiment_id):
            self.experiment_id = experiment_id

    fake_mlflow = types.ModuleType("mlflow")
    fake_mlflow.tracing = types.SimpleNamespace(
        set_destination=lambda location, **kwargs: calls.update(
            {"experiment_id": location.experiment_id, "kwargs": kwargs}
        )
    )
    fake_mlflow.set_tracking_uri = lambda uri: calls.update({"tracking_uri": uri})

    fake_entities = types.ModuleType("mlflow.entities")
    fake_trace_location = types.ModuleType("mlflow.entities.trace_location")
    fake_trace_location.MlflowExperimentLocation = FakeMlflowExperimentLocation

    monkeypatch.setitem(sys.modules, "mlflow", fake_mlflow)
    monkeypatch.setitem(sys.modules, "mlflow.entities", fake_entities)
    monkeypatch.setitem(sys.modules, "mlflow.entities.trace_location", fake_trace_location)
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://mlflow:5000")

    from src.telemetry.providers import set_mlflow_trace_experiment_for_context

    assert set_mlflow_trace_experiment_for_context("per-workflow-11") is True
    assert calls == {
        "tracking_uri": "http://mlflow:5000",
        "experiment_id": "per-workflow-11",
        "kwargs": {"context_local": True},
    }


def test_beta_tracing_adds_content_when_flag_set(monkeypatch, telemetry_with_in_memory):
    exporter, _ = telemetry_with_in_memory
    monkeypatch.setenv("ENABLE_BETA_TRACING_DETAILED", "1")
    from src.telemetry import end_interaction_span, start_interaction_span

    start_interaction_span("what is 2+2")
    end_interaction_span()

    interaction = _find_span(exporter, "claude_code.interaction")
    # Beta attrs populated only when flag is set.
    assert "new_context" in interaction.attributes


def test_beta_tracing_absent_when_flag_unset(telemetry_with_in_memory):
    exporter, _ = telemetry_with_in_memory
    from src.telemetry import end_interaction_span, start_interaction_span

    start_interaction_span("hello")
    end_interaction_span()

    interaction = _find_span(exporter, "claude_code.interaction")
    assert "new_context" not in interaction.attributes


def test_hook_span_gated_on_beta_flag(telemetry_with_in_memory, monkeypatch):
    exporter, _ = telemetry_with_in_memory

    from src.telemetry import end_hook_span, start_hook_span

    # Without beta flag: no span emitted.
    monkeypatch.delenv("ENABLE_BETA_TRACING_DETAILED", raising=False)
    span = start_hook_span("PreToolUse", "PreToolUse:Edit", 1, "[]")
    end_hook_span(span)
    assert _find_span(exporter, "claude_code.hook") is None

    # With beta flag: span appears.
    monkeypatch.setenv("ENABLE_BETA_TRACING_DETAILED", "1")
    span2 = start_hook_span("PreToolUse", "PreToolUse:Edit", 2, "[]")
    end_hook_span(span2, num_success=2)
    hook_span = _find_span(exporter, "claude_code.hook")
    assert hook_span is not None
    assert hook_span.attributes["hook_event"] == "PreToolUse"
    assert hook_span.attributes["num_hooks"] == 2
    assert hook_span.attributes["num_success"] == 2
