"""Unit tests for src/telemetry.

Uses in-memory span/metric/log exporters so tests run without an OTLP
collector. Asserts span hierarchy (claude_code.interaction ▸ tool ▸
tool.execution, and llm_request under interaction), attribute presence,
and metric counter increments — the minimum that proves the TS port
emits the names and shapes external dashboards expect.
"""

from __future__ import annotations

import json
import os
import sys
import types
from urllib.parse import parse_qs, unquote, urlsplit

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


def _serialized_span_attributes(span):
    return json.dumps(dict(span.attributes), default=str, sort_keys=True)


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
    assert interaction.attributes["openinference.span.kind"] == "AGENT"
    assert "mlflow.spanType" not in interaction.attributes
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
    assert llm_span.attributes["openinference.span.kind"] == "LLM"
    assert "mlflow.spanType" not in llm_span.attributes
    # llm_request should be a child of interaction.
    assert llm_span.parent is not None
    assert llm_span.parent.span_id == interaction.context.span_id

    tool_span = _find_span(exporter, "claude_code.tool")
    assert tool_span.attributes["tool_name"] == "Edit"
    assert tool_span.attributes["tool.call_id"] == "tc-1"
    assert tool_span.attributes["openinference.span.kind"] == "TOOL"
    assert "mlflow.spanType" not in tool_span.attributes
    assert tool_span.parent.span_id == interaction.context.span_id

    exec_span_out = _find_span(exporter, "claude_code.tool.execution")
    assert exec_span_out.attributes["success"] is True
    assert exec_span_out.attributes["openinference.span.kind"] == "TOOL"
    assert "mlflow.spanType" not in exec_span_out.attributes
    assert exec_span_out.parent.span_id == tool_span.context.span_id


def test_failed_tool_result_marks_canonical_activity_error(telemetry_with_in_memory):
    exporter, _ = telemetry_with_in_memory
    from opentelemetry.trace import StatusCode

    from src.telemetry import end_tool_span, start_tool_span
    from src.telemetry.providers import get_tracer

    tracer = get_tracer()
    assert tracer is not None
    with tracer.start_as_current_span("agent-session-test.run_tool") as activity:
        start_tool_span(
            "browser_agent_browser_open",
            tool_input='{"url":"https://example.test"}',
        )
        end_tool_span(
            tool_result=json.dumps(
                {
                    "content": "Error: McpError: timed out after 180.0 seconds",
                    "role": "tool",
                }
            ),
            success=False,
            error="Error: McpError: timed out after 180.0 seconds",
        )
        assert activity.status.status_code is StatusCode.ERROR

    canonical = _find_span(exporter, "agent-session-test.run_tool")
    helper = _find_span(exporter, "claude_code.tool")
    assert canonical.status.status_code is StatusCode.ERROR
    assert (
        canonical.status.description == "Error: McpError: timed out after 180.0 seconds"
    )
    assert canonical.attributes["openinference.span.kind"] == "TOOL"
    assert canonical.attributes["tool.name"] == "browser_agent_browser_open"
    assert canonical.attributes["success"] is False
    assert helper.status.status_code is StatusCode.ERROR


def test_current_trace_context_prefers_active_llm_span(telemetry_with_in_memory):
    exporter, _ = telemetry_with_in_memory
    from src.telemetry import (
        end_interaction_span,
        end_llm_request_span,
        start_interaction_span,
        start_llm_request_span,
    )
    from src.telemetry.session_tracing import get_current_trace_context

    interaction = start_interaction_span("hello")
    llm = start_llm_request_span("gpt-5.5")
    trace_id, span_id = get_current_trace_context()

    assert trace_id == f"{llm.get_span_context().trace_id:032x}"
    assert span_id == f"{llm.get_span_context().span_id:016x}"
    assert trace_id == f"{interaction.get_span_context().trace_id:032x}"

    end_llm_request_span(llm, success=True)
    end_interaction_span()
    assert _find_span(exporter, "claude_code.llm_request") is not None


def test_user_prompt_logged_when_env_truthy(telemetry_with_in_memory, monkeypatch):
    exporter, _ = telemetry_with_in_memory
    monkeypatch.setenv("OTEL_LOG_USER_PROMPTS", "1")

    from src.telemetry import end_interaction_span, start_interaction_span

    start_interaction_span("top secret prompt")
    end_interaction_span()

    interaction = _find_span(exporter, "claude_code.interaction")
    assert interaction.attributes["user_prompt"] == "top secret prompt"


def test_user_prompt_span_event_sanitizes_enabled_prompt_content(
    telemetry_with_in_memory, monkeypatch
):
    exporter, _ = telemetry_with_in_memory
    monkeypatch.setenv("OTEL_LOG_USER_PROMPTS", "1")

    from src.telemetry import emit_user_prompt_event
    from src.telemetry.providers import get_tracer

    payload = "c2NyZWVuc2hvdC1ieXRlcw=="
    prompt = (
        f"inspect data:image/png;base64,{payload} "
        "at https://artifacts.example/frame.png?access_token=prompt-token "
        "Authorization: Bearer prompt-bearer"
    )
    span = get_tracer().start_span("test.user_prompt")
    emit_user_prompt_event(span, prompt)
    span.end()

    exported = _find_span(exporter, "test.user_prompt")
    event = next(
        item for item in exported.events if item.name == "claude_code.user_prompt"
    )
    safe_prompt = event.attributes["prompt"]
    assert payload not in safe_prompt
    assert "data:image" not in safe_prompt
    assert "prompt-token" not in safe_prompt
    assert "prompt-bearer" not in safe_prompt
    assert "REDACTED_INLINE_MEDIA" in safe_prompt
    assert "artifacts.example/frame.png" in safe_prompt


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
        attrs = dict(
            _iter_context_bridge_attrs(lambda: iter([("session.id", "oi-session")]))
        )
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


def test_beta_tracing_adds_content_when_flag_set(monkeypatch, telemetry_with_in_memory):
    exporter, _ = telemetry_with_in_memory
    monkeypatch.setenv("ENABLE_BETA_TRACING_DETAILED", "1")
    from src.telemetry import end_interaction_span, start_interaction_span

    start_interaction_span("what is 2+2")
    end_interaction_span()

    interaction = _find_span(exporter, "claude_code.interaction")
    # Beta attrs populated only when flag is set.
    assert "new_context" in interaction.attributes
    assert json.loads(interaction.attributes["input.value"]) == {
        "user_prompt": "what is 2+2"
    }


def test_beta_tracing_aliases_llm_and_tool_content_for_service_graph(
    monkeypatch, telemetry_with_in_memory
):
    exporter, _ = telemetry_with_in_memory
    monkeypatch.setenv("ENABLE_BETA_TRACING_DETAILED", "1")
    from src.telemetry import (
        end_interaction_span,
        end_llm_request_span,
        end_tool_span,
        start_interaction_span,
        start_llm_request_span,
        start_tool_span,
    )

    start_interaction_span("use the tool")
    llm = start_llm_request_span(
        "test-model",
        query_source="unit",
        system_prompt="system secret_token should be redacted by key only",
        messages_for_api=[
            {
                "role": "user",
                "content": "hello",
                "api_key": "should-not-appear",
            }
        ],
        tools_json='[{"name":"Bash","input_schema":{"type":"object"}}]',
    )
    end_llm_request_span(
        llm,
        success=True,
        status_code=200,
        model_output="done",
        input_tokens=3,
        output_tokens=2,
        cache_read_tokens=1,
    )
    start_tool_span(
        "Bash",
        tool_input='{"command":"echo hi","password":"should-not-appear"}',
    )
    end_tool_span(tool_result='{"stdout":"hi"}', result_tokens=1)
    end_interaction_span()

    llm_span = _find_span(exporter, "claude_code.llm_request")
    llm_input = json.loads(llm_span.attributes["input.value"])
    assert llm_input["model"] == "test-model"
    assert llm_input["messages"][0]["api_key"] == "[REDACTED]"
    assert llm_input["tools"][0]["name"] == "Bash"
    assert json.loads(llm_span.attributes["output.value"])["model_output"] == "done"
    assert json.loads(llm_span.attributes["output.value"])["input_tokens"] == 3
    assert json.loads(llm_span.attributes["output.value"])["cache_read_tokens"] == 1

    tool_span = _find_span(exporter, "claude_code.tool")
    tool_input = json.loads(tool_span.attributes["input.value"])
    assert tool_input["tool_name"] == "Bash"
    assert tool_input["input"]["password"] == "[REDACTED]"
    assert json.loads(tool_span.attributes["output.value"])["result"] == {
        "stdout": "hi"
    }


def test_inline_media_is_redacted_and_artifact_references_are_retained():
    from src.telemetry.content_sanitizer import (
        sanitize_content_for_telemetry,
        sanitize_text_for_telemetry,
    )

    payload = "c2NyZWVuc2hvdC1ieXRlcw=="
    data_uri = f"data:image/png;base64,{payload}"
    storage_ref = "browser-artifacts/exec-1/screenshots/step-4.png"
    media_ref = "ms://file/browser-screenshot-4"
    value = {
        "content": [
            {"type": "image_url", "image_url": {"url": data_uri}},
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": payload,
                },
            },
        ],
        "storageRef": storage_ref,
        "mediaUrl": media_ref,
    }

    serialized = json.dumps(sanitize_content_for_telemetry(value), sort_keys=True)
    embedded = sanitize_text_for_telemetry(json.dumps(value))

    for safe_value in (serialized, embedded):
        assert payload not in safe_value
        assert "data:image" not in safe_value
        assert "REDACTED_INLINE_MEDIA" in safe_value
        assert "mime=image/png" in safe_value
        assert "mime=image/jpeg" in safe_value
        assert storage_ref in safe_value
        assert media_ref in safe_value


def test_nested_openai_audio_and_analogous_media_payloads_are_redacted():
    from src.telemetry.content_sanitizer import sanitize_content_for_telemetry

    payload = "YXVkaW8tYnl0ZXM="
    value = {
        "content": [
            {
                "type": "input_audio",
                "input_audio": {"data": payload, "format": "wav"},
            },
            {"audio": {"data": payload, "format": "mp3"}},
            {"input_video": {"data": payload, "format": "mp4"}},
        ]
    }

    serialized = json.dumps(sanitize_content_for_telemetry(value), sort_keys=True)

    assert payload not in serialized
    assert serialized.count("REDACTED_INLINE_MEDIA") == 3
    assert "mime=audio/wav" in serialized
    assert "mime=audio/mpeg" in serialized
    assert "mime=video/mp4" in serialized


def test_tokens_signed_urls_userinfo_and_bearer_text_are_safely_redacted():
    from src.telemetry.content_sanitizer import (
        sanitize_content_for_telemetry,
        sanitize_text_for_telemetry,
    )

    signed_url = (
        "https://artifact-user:artifact-password@artifacts.example/"
        "runs/exec-1/frame.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&"
        "X-Amz-Credential=secret-credential&X-Amz-Signature=secret-signature&"
        "X-Amz-Security-Token=secret-security-token&access_token=secret-token&"
        "response-content-type=image%2Fpng#frame"
    )
    value = {
        "accessToken": "camel-access-token",
        "refreshToken": "camel-refresh-token",
        "authToken": "camel-auth-token",
        "artifactUrl": signed_url,
        "message": "Authorization: Bearer secret-bearer",
    }

    safe = sanitize_content_for_telemetry(value)
    safe_url = urlsplit(safe["artifactUrl"])
    query = parse_qs(safe_url.query)

    assert safe["accessToken"] == "[REDACTED]"
    assert safe["refreshToken"] == "[REDACTED]"
    assert safe["authToken"] == "[REDACTED]"
    assert safe["message"] == "Authorization: Bearer [REDACTED]"
    assert safe_url.scheme == "https"
    assert safe_url.hostname == "artifacts.example"
    assert safe_url.path == "/runs/exec-1/frame.png"
    assert safe_url.fragment == "frame"
    assert unquote(safe_url.username or "") == "[REDACTED]"
    assert safe_url.password is None
    assert query["X-Amz-Algorithm"] == ["AWS4-HMAC-SHA256"]
    assert query["response-content-type"] == ["image/png"]
    for key in (
        "X-Amz-Credential",
        "X-Amz-Signature",
        "X-Amz-Security-Token",
        "access_token",
    ):
        assert query[key] == ["[REDACTED]"]

    safe_text = sanitize_text_for_telemetry(
        f"download={signed_url} Authorization: Bearer another-secret"
    )
    for secret in (
        "artifact-user",
        "artifact-password",
        "secret-credential",
        "secret-signature",
        "secret-security-token",
        "secret-token",
        "another-secret",
    ):
        assert secret not in safe_text
    assert "artifacts.example" in safe_text
    assert "/runs/exec-1/frame.png" in safe_text


def test_malformed_signed_urls_fail_closed_without_destroying_url_identity():
    from src.telemetry.content_sanitizer import sanitize_text_for_telemetry

    safe = sanitize_text_for_telemetry(
        "http://artifact-user:artifact-password@x:abc/frame.png?token=secret-token"
    )

    assert "artifact-user" not in safe
    assert "artifact-password" not in safe
    assert "secret-token" not in safe
    assert "x:abc/frame.png" in safe
    assert "token=" in safe


def test_json_schema_property_names_are_preserved_while_runtime_values_are_redacted():
    from src.telemetry.content_sanitizer import sanitize_content_for_telemetry

    schema = {
        "type": "object",
        "properties": {
            "accessToken": {
                "type": "string",
                "description": "Access token",
                "default": "actual-default-token",
                "examples": ["actual-example-token"],
            },
            "password": {
                "type": "string",
                "minLength": 8,
                "const": "actual-password",
                "enum": ["actual-password", "other-password"],
            },
            "nested": {
                "type": "object",
                "properties": {"authToken": {"type": "string"}},
            },
        },
        "required": ["accessToken", "password"],
    }

    safe_schema = sanitize_content_for_telemetry(schema)
    assert set(safe_schema["properties"]) == {"accessToken", "password", "nested"}
    assert safe_schema["properties"]["accessToken"]["type"] == "string"
    assert safe_schema["properties"]["accessToken"]["description"] == "Access token"
    assert safe_schema["properties"]["accessToken"]["default"] == "[REDACTED]"
    assert safe_schema["properties"]["accessToken"]["examples"] == ["[REDACTED]"]
    assert safe_schema["properties"]["password"]["const"] == "[REDACTED]"
    assert safe_schema["properties"]["password"]["enum"] == [
        "[REDACTED]",
        "[REDACTED]",
    ]
    assert safe_schema["properties"]["nested"] == schema["properties"]["nested"]
    assert safe_schema["required"] == ["accessToken", "password"]
    assert sanitize_content_for_telemetry(
        {"properties": {"accessToken": "actual-token"}}
    ) == {"properties": {"accessToken": "[REDACTED]"}}
    for runtime_payload in (
        {"type": "object", "properties": {"accessToken": "typed-runtime-token"}},
        {"schema": {"properties": {"accessToken": "schema-runtime-token"}}},
        {"parameters": {"properties": {"accessToken": "parameters-runtime-token"}}},
    ):
        assert "runtime-token" not in json.dumps(
            sanitize_content_for_telemetry(runtime_payload)
        )
    disguised_runtime = {
        "type": "object",
        "properties": {
            "accessToken": {"type": "string", "value": "disguised-runtime-token"}
        },
    }
    assert "disguised-runtime-token" not in json.dumps(
        sanitize_content_for_telemetry(disguised_runtime)
    )
    assert sanitize_content_for_telemetry(
        {
            "accessToken": "runtime-access-token",
            "password": "runtime-password",
            "authToken": "runtime-auth-token",
        }
    ) == {
        "accessToken": "[REDACTED]",
        "password": "[REDACTED]",
        "authToken": "[REDACTED]",
    }


def test_ambient_call_llm_is_the_only_llm_content_span(
    monkeypatch, telemetry_with_in_memory
):
    exporter, _ = telemetry_with_in_memory
    monkeypatch.setenv("ENABLE_BETA_TRACING_DETAILED", "1")

    from src.telemetry import (
        end_llm_request_span,
        get_span_trace_context,
        start_llm_request_span,
    )
    from src.telemetry.providers import get_tracer
    from src.telemetry.session_tracing import get_current_trace_context

    payload = "c2NyZWVuc2hvdC1ieXRlcw=="
    data_uri = f"data:image/png;base64,{payload}"
    storage_ref = "browser-artifacts/exec-1/screenshots/step-4.png"
    media_ref = "ms://file/browser-screenshot-4"
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Inspect this browser screenshot."},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": data_uri,
                        "storageRef": storage_ref,
                        "mediaUrl": media_ref,
                    },
                },
                {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "type": "image",
                            "mimeType": "image/jpeg",
                            "data": payload,
                            "storageRef": storage_ref,
                        }
                    ),
                },
            ],
        }
    ]
    tracer = get_tracer()
    raw_activity_input = json.dumps({"messages": messages})

    with tracer.start_as_current_span(
        "WorkflowActivity.dapr.agents.dapr-agent-py.call_llm",
        attributes={
            "openinference.span.kind": "LLM",
            "input.value": raw_activity_input,
        },
    ) as activity:
        child = start_llm_request_span(
            "kimi-k3",
            query_source="test.canonical-media",
            messages_for_api=messages,
        )
        canonical_context = (
            f"{activity.get_span_context().trace_id:032x}",
            f"{activity.get_span_context().span_id:016x}",
        )
        assert get_span_trace_context(child) == canonical_context
        assert get_current_trace_context() == canonical_context
        end_llm_request_span(
            child,
            success=True,
            model_output="Screenshot inspected.",
        )
        # Kimi usage is published after the helper child closes but while the
        # upstream Dapr call_llm activity remains current.
        assert get_current_trace_context() == canonical_context

    spans = exporter.get_finished_spans()
    activity_span = next(span for span in spans if span.name == activity.name)
    child_span = next(span for span in spans if span.name == "claude_code.llm_request")
    llm_spans = [
        span
        for span in spans
        if span.attributes.get("openinference.span.kind") == "LLM"
    ]

    assert llm_spans == [activity_span]
    assert child_span.attributes["openinference.span.kind"] == "CHAIN"
    assert child_span.parent.span_id == activity_span.context.span_id
    assert "llm.input_messages" in activity_span.attributes
    assert "llm.output_messages" in activity_span.attributes
    assert "input.value" in activity_span.attributes
    assert "output.value" in activity_span.attributes
    assert "llm.input_messages" not in child_span.attributes
    assert "llm.output_messages" not in child_span.attributes
    assert "input.value" not in child_span.attributes
    assert "output.value" not in child_span.attributes
    assert "new_context" not in child_span.attributes

    all_attributes = "\n".join(_serialized_span_attributes(span) for span in spans)
    assert payload not in all_attributes
    assert "data:image" not in all_attributes
    assert "REDACTED_INLINE_MEDIA" in all_attributes
    assert storage_ref in all_attributes
    assert media_ref in all_attributes


def test_standalone_llm_request_remains_the_canonical_fallback(
    monkeypatch, telemetry_with_in_memory
):
    exporter, _ = telemetry_with_in_memory
    monkeypatch.setenv("ENABLE_BETA_TRACING_DETAILED", "1")

    from src.telemetry import end_llm_request_span, start_llm_request_span

    messages = [{"role": "user", "content": "hello"}]
    child = start_llm_request_span(
        "kimi-k3",
        query_source="test.standalone",
        messages_for_api=messages,
    )
    end_llm_request_span(child, success=True, model_output="hello")

    spans = exporter.get_finished_spans()
    llm_spans = [
        span
        for span in spans
        if span.attributes.get("openinference.span.kind") == "LLM"
    ]

    assert len(llm_spans) == 1
    assert llm_spans[0].name == "claude_code.llm_request"
    assert json.loads(llm_spans[0].attributes["llm.input_messages"]) == messages
    assert json.loads(llm_spans[0].attributes["llm.output_messages"]) == [
        {"role": "assistant", "content": "hello"}
    ]


def test_beta_tool_content_sanitizes_embedded_media_and_keeps_evidence_refs(
    monkeypatch, telemetry_with_in_memory
):
    exporter, _ = telemetry_with_in_memory
    monkeypatch.setenv("ENABLE_BETA_TRACING_DETAILED", "1")

    from src.telemetry import end_tool_span, start_tool_span

    payload = "c2NyZWVuc2hvdC1ieXRlcw=="
    storage_ref = "browser-artifacts/exec-2/screenshots/step-1.png"
    tool_content = json.dumps(
        {
            "screenshot": {
                "type": "image",
                "mimeType": "image/png",
                "data": payload,
            },
            "storageRef": storage_ref,
        }
    )

    start_tool_span("browser_screenshot", tool_input=tool_content)
    end_tool_span(tool_result=tool_content)

    tool_span = _find_span(exporter, "claude_code.tool")
    attributes = _serialized_span_attributes(tool_span)
    assert payload not in attributes
    assert "data:image" not in attributes
    assert "REDACTED_INLINE_MEDIA" in attributes
    assert storage_ref in attributes


def test_state_tracing_redacts_content_before_serialization():
    from src.telemetry.state_tracing import _to_json

    payload = {
        "api_key": "should-not-appear",
        "input_tokens": 123,
        "nested": {
            "password": "should-not-appear",
            "refresh_token": "should-not-appear",
        },
    }

    serialized = json.loads(_to_json(payload))
    assert serialized == {
        "api_key": "[REDACTED]",
        "input_tokens": 123,
        "nested": {
            "password": "[REDACTED]",
            "refresh_token": "[REDACTED]",
        },
    }


def test_state_tracing_stamps_request_and_response_content(
    monkeypatch, telemetry_with_in_memory
):
    exporter, _ = telemetry_with_in_memory
    monkeypatch.setenv("ENABLE_STATE_CONTENT_TRACING", "1")

    fake_dapr_agents = types.ModuleType("dapr_agents")
    fake_storage = types.ModuleType("dapr_agents.storage")
    fake_daprstores = types.ModuleType("dapr_agents.storage.daprstores")
    fake_stateservice = types.ModuleType("dapr_agents.storage.daprstores.stateservice")

    class FakeStateStoreService:
        store_name = "agent-registry"

        def _qualify(self, key):
            return f"agents:default:{key}"

        def load(self, key):
            return {"api_key": "should-not-appear", "value": 7}

        def save(self, key, value):
            return None

        def delete(self, key):
            return None

    fake_stateservice.StateStoreService = FakeStateStoreService
    monkeypatch.setitem(sys.modules, "dapr_agents", fake_dapr_agents)
    monkeypatch.setitem(sys.modules, "dapr_agents.storage", fake_storage)
    monkeypatch.setitem(sys.modules, "dapr_agents.storage.daprstores", fake_daprstores)
    monkeypatch.setitem(
        sys.modules,
        "dapr_agents.storage.daprstores.stateservice",
        fake_stateservice,
    )

    from src.telemetry.state_tracing import instrument_state_store

    instrument_state_store()
    store = FakeStateStoreService()

    assert store.load("session-1") == {"api_key": "should-not-appear", "value": 7}
    assert (
        store.save("session-1", {"password": "should-not-appear", "value": 8}) is None
    )
    assert store.delete("session-1") is None

    load_span = _find_span(exporter, "state.load")
    save_span = _find_span(exporter, "state.save")
    delete_span = _find_span(exporter, "state.delete")
    assert json.loads(load_span.attributes["input.value"]) == {
        "operation": "load",
        "key": "agents:default:session-1",
    }
    assert json.loads(load_span.attributes["output.value"]) == {
        "api_key": "[REDACTED]",
        "value": 7,
    }
    assert json.loads(save_span.attributes["input.value"]) == {
        "operation": "save",
        "key": "agents:default:session-1",
        "value": {"password": "[REDACTED]", "value": 8},
    }
    assert json.loads(save_span.attributes["output.value"]) == {"ok": True}
    assert json.loads(delete_span.attributes["input.value"]) == {
        "operation": "delete",
        "key": "agents:default:session-1",
    }
    assert json.loads(delete_span.attributes["output.value"]) == {"ok": True}


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


def test_interaction_adopts_inbound_trace_context_on_bare_threads(
    telemetry_with_in_memory, monkeypatch
):
    """`claude_code.interaction` must join the orchestrator's trace even when
    created on a thread with an EMPTY otel context (Dapr activity gRPC workers)
    — the shattered-trace bug: interaction roots forked fresh traces while
    their children joined the primary trace via ambient context."""
    import threading

    from opentelemetry.propagate import extract

    from src.telemetry import providers as providers_module
    from src.telemetry.session_tracing import (
        end_interaction_span,
        start_interaction_span,
    )

    exporter, _ = telemetry_with_in_memory

    inbound_trace_id = "9fc592127bf865aceab30f09a1b39ee0"
    carrier = {"traceparent": f"00-{inbound_trace_id}-00f067aa0ba902b7-01"}
    monkeypatch.setattr(providers_module, "_inbound_trace_context", extract(carrier))

    # A fresh thread starts with an empty contextvars Context — exactly the
    # environment where the old code rooted a new trace.
    def run_turn():
        span = start_interaction_span("hello")
        assert span is not None
        end_interaction_span()

    t = threading.Thread(target=run_turn)
    t.start()
    t.join()

    spans = exporter.get_finished_spans()
    interaction = next(s for s in spans if s.name == "claude_code.interaction")
    assert f"{interaction.context.trace_id:032x}" == inbound_trace_id
    assert interaction.parent is not None
    assert f"{interaction.parent.span_id:016x}" == "00f067aa0ba902b7"


def test_interaction_prefers_ambient_span_over_inbound(
    telemetry_with_in_memory, monkeypatch
):
    """When a valid span IS current (instrumented request path), the ambient
    context stays authoritative — inbound env context is only a fallback."""
    from opentelemetry.propagate import extract

    from src.telemetry import providers as providers_module
    from src.telemetry.providers import get_tracer
    from src.telemetry.session_tracing import (
        end_interaction_span,
        start_interaction_span,
    )

    exporter, _ = telemetry_with_in_memory
    monkeypatch.setattr(
        providers_module,
        "_inbound_trace_context",
        extract(
            {"traceparent": "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-00f067aa0ba902b7-01"}
        ),
    )

    tracer = get_tracer()
    with tracer.start_as_current_span("ambient-parent") as parent:
        span = start_interaction_span("hello")
        assert span is not None
        end_interaction_span()
        ambient_trace_id = parent.get_span_context().trace_id

    spans = exporter.get_finished_spans()
    interaction = next(s for s in spans if s.name == "claude_code.interaction")
    assert interaction.context.trace_id == ambient_trace_id
