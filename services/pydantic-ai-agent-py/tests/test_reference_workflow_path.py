"""Production-path tests for reference-backed agent transcript choreography."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from dapr.ext.workflow._durabletask.internal.helpers import new_failure_details
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.usage import RequestUsage

import src.workflow as workflow_module
from src.messages_io import dump_messages, load_messages
from src.workflow import (
    TRANSCRIPT_INTEGRITY_ERROR,
    agent_workflow,
    call_llm,
    check_cancellation,
    commit_tool_results,
    execute_tool,
)


class FakeActivityContext:
    workflow_id = "wf-reference-path"
    task_id = 1


class FakeWorkflowContext:
    instance_id = "wf-reference-path"

    def __init__(self) -> None:
        self.calls: list[tuple[Any, dict[str, Any], Any]] = []

    def call_activity(self, activity, *, input=None, retry_policy=None):
        self.calls.append((activity, input, retry_policy))
        return ("activity", activity, input, retry_policy)


class QueuedModel:
    model_name = "kimi-k3"

    def __init__(self, responses: list[list[Any]]) -> None:
        self.responses = list(responses)
        self.requests: list[list[Any]] = []

    async def request(self, messages, model_settings, model_request_parameters):
        del model_settings, model_request_parameters
        self.requests.append(list(messages))
        parts = self.responses.pop(0)
        return ModelResponse(
            parts=parts,
            usage=RequestUsage(input_tokens=20, output_tokens=10),
            model_name=self.model_name,
            finish_reason=(
                "tool_call"
                if any(isinstance(part, ToolCallPart) for part in parts)
                else "stop"
            ),
        )


@pytest.fixture(autouse=True)
def _reference_path_runtime(monkeypatch):
    monkeypatch.setattr(workflow_module, "KIMI_STREAMING_ENABLED", False)
    monkeypatch.setattr(
        workflow_module.wf,
        "when_all",
        lambda tasks: ("when_all", tasks),
    )


def _history_store():
    return workflow_module.durable_history_port(workflow_module.WORKSPACE_ROOT)


def _invoke_scheduled(task):
    assert task[0] == "activity"
    activity, payload = task[1], task[2]
    if activity is check_cancellation:
        return {"cancelled": False}
    return activity(FakeActivityContext(), payload)


def test_reference_activity_path_resolves_args_commits_and_loads_next_call(
    monkeypatch,
):
    model = QueuedModel(
        [
            [
                ThinkingPart(content="plan the writes"),
                ToolCallPart(
                    tool_name="write_file",
                    args={"path": "exact-one.txt", "content": "first"},
                    tool_call_id="write-1",
                ),
                ToolCallPart(
                    tool_name="write_file",
                    args={"path": "exact-two.txt", "content": "second"},
                    tool_call_id="write-2",
                ),
            ],
            [TextPart(content="both exact files were written")],
        ]
    )
    monkeypatch.setattr(workflow_module, "build_model", lambda: model)

    first = call_llm(
        FakeActivityContext(),
        {"task": "write two exact files", "context": {}, "iteration": 0},
    )

    assert set(first) == {"historyRef", "responseRef", "toolCalls", "text"}
    assert first["historyRef"].startswith("history+sha256://")
    assert first["responseRef"].startswith("message+sha256://")
    assert first["text"] == ""
    assert [call["toolIndex"] for call in first["toolCalls"]] == [0, 1]
    assert all(
        call["responseRef"] == first["responseRef"]
        and "args" not in call
        and set(call)
        == {
            "isStructuredOutput",
            "responseRef",
            "sequential",
            "toolIndex",
        }
        for call in first["toolCalls"]
    )
    store = _history_store()
    first_history = store.load(first["historyRef"])
    assert store.load_message(first["responseRef"]) == first_history[-1]

    tool_results = []
    for call in first["toolCalls"]:
        poisoned_projection = {
            **call,
            "args": {"path": "wrong.txt", "content": "wrong"},
        }
        tool_results.append(
            execute_tool(
                FakeActivityContext(),
                {"call": poisoned_projection, "context": {}, "iteration": 0},
            )
        )

    workspace = Path(workflow_module.WORKSPACE_ROOT)
    assert (workspace / "exact-one.txt").read_text() == "first"
    assert (workspace / "exact-two.txt").read_text() == "second"
    assert not (workspace / "wrong.txt").exists()
    assert all(
        result["messageRef"].startswith("message+sha256://") and "message" not in result
        for result in tool_results
    )

    reordered = commit_tool_results(
        FakeActivityContext(),
        {
            "historyRef": first["historyRef"],
            "messageRefs": [
                tool_results[1]["messageRef"],
                tool_results[0]["messageRef"],
            ],
        },
    )
    assert reordered["configurationErrorCode"] == TRANSCRIPT_INTEGRITY_ERROR

    committed = commit_tool_results(
        FakeActivityContext(),
        {
            "historyRef": first["historyRef"],
            "messageRefs": [result["messageRef"] for result in tool_results],
        },
    )
    assert set(committed) == {"historyRef"}
    committed_messages = load_messages(store.load(committed["historyRef"]))
    calls = [
        part
        for message in committed_messages
        if isinstance(message, ModelResponse)
        for part in message.parts
        if isinstance(part, ToolCallPart)
    ]
    returns = [
        part
        for message in committed_messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    ]
    assert [part.tool_call_id for part in calls] == ["write-1", "write-2"]
    assert [part.tool_call_id for part in returns] == ["write-1", "write-2"]

    second = call_llm(
        FakeActivityContext(),
        {
            "task": "confirm what changed",
            "historyRef": committed["historyRef"],
            "context": {},
            "iteration": 1,
        },
    )
    assert second["text"] == "both exact files were written"
    assert second["historyRef"].startswith("history+sha256://")
    assert second["responseRef"].startswith("message+sha256://")
    loaded_ids = [
        part.tool_call_id
        for message in model.requests[1]
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    ]
    assert loaded_ids == ["write-1", "write-2"]
    assert isinstance(model.requests[1][-1].parts[-1], UserPromptPart)
    assert model.requests[1][-1].parts[-1].content == "confirm what changed"


def test_structured_output_workflow_commits_result_before_finalizing(monkeypatch):
    model = QueuedModel(
        [
            [
                ToolCallPart(
                    tool_name="StructuredOutput",
                    args={"summary": "complete"},
                    tool_call_id="structured-1",
                )
            ]
        ]
    )
    monkeypatch.setattr(workflow_module, "build_model", lambda: model)
    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["summary"],
        "properties": {"summary": {"type": "string"}},
    }
    context = FakeWorkflowContext()
    workflow = agent_workflow(
        context,
        {
            "task": "finish with structured output",
            "context": {
                "agentConfig": {
                    "structuredOutputMode": "tool",
                    "responseJsonSchema": schema,
                }
            },
        },
    )

    scheduled = next(workflow)
    assert scheduled[1] is check_cancellation
    scheduled = workflow.send(_invoke_scheduled(scheduled))
    assert scheduled[1] is call_llm
    scheduled = workflow.send(_invoke_scheduled(scheduled))
    assert scheduled[0] == "when_all"
    tool_results = [_invoke_scheduled(task) for task in scheduled[1]]
    scheduled = workflow.send(tool_results)
    assert scheduled[1] is commit_tool_results
    commit_input = scheduled[2]
    assert commit_input["historyRef"].startswith("history+sha256://")
    assert commit_input["messageRefs"] == [tool_results[0]["messageRef"]]
    assert set(commit_input) == {"historyRef", "messageRefs"}
    commit_result = _invoke_scheduled(scheduled)
    with pytest.raises(StopIteration) as stopped:
        workflow.send(commit_result)

    result = stopped.value.value
    assert [call[0] for call in context.calls] == [
        check_cancellation,
        call_llm,
        execute_tool,
        commit_tool_results,
    ]
    assert result["success"] is True
    assert result["content"] == '{"summary": "complete"}'
    assert result["historyRef"] == commit_result["historyRef"]
    assert "messages" not in result


def test_legacy_inline_history_migrates_once_then_uses_only_reference(monkeypatch):
    model = QueuedModel(
        [
            [TextPart(content="migrated")],
            [TextPart(content="continued from reference")],
        ]
    )
    monkeypatch.setattr(workflow_module, "build_model", lambda: model)
    legacy_history = dump_messages(
        [ModelRequest(parts=[UserPromptPart(content="legacy request")])]
    )
    context = FakeWorkflowContext()
    workflow = agent_workflow(
        context,
        {"task": None, "history": legacy_history, "context": {}},
    )

    scheduled = next(workflow)
    scheduled = workflow.send(_invoke_scheduled(scheduled))
    assert scheduled[1] is call_llm
    assert scheduled[2]["messages"] == legacy_history
    assert scheduled[2]["migrateInlineHistory"] is True
    assert "historyRef" not in scheduled[2]
    first_activity_result = _invoke_scheduled(scheduled)
    assert first_activity_result["historyRef"].startswith("history+sha256://")
    assert first_activity_result["responseRef"].startswith("message+sha256://")
    assert "messages" not in first_activity_result
    with pytest.raises(StopIteration) as stopped:
        workflow.send(first_activity_result)
    first_result = stopped.value.value
    assert first_result["historyRef"] == first_activity_result["historyRef"]
    assert "messages" not in first_result

    resumed_context = FakeWorkflowContext()
    resumed = agent_workflow(
        resumed_context,
        {
            "task": "continue",
            "historyRef": first_result["historyRef"],
            "context": {},
        },
    )
    scheduled = next(resumed)
    scheduled = resumed.send(_invoke_scheduled(scheduled))
    assert scheduled[1] is call_llm
    assert scheduled[2]["historyRef"] == first_result["historyRef"]
    assert "messages" not in scheduled[2]
    assert "migrateInlineHistory" not in scheduled[2]
    resumed_activity_result = _invoke_scheduled(scheduled)
    with pytest.raises(StopIteration) as resumed_stopped:
        resumed.send(resumed_activity_result)

    assert resumed_stopped.value.value["content"] == "continued from reference"
    assert "messages" not in resumed_stopped.value.value


def _configured_history(monkeypatch, tmp_path):
    monkeypatch.setattr(workflow_module, "WORKSPACE_ROOT", str(tmp_path))
    workflow_module.durable_history_port.cache_clear()
    workflow_module.durable_media_port.cache_clear()
    store = workflow_module.durable_history_port(str(tmp_path))
    history_ref = store.save(
        dump_messages(
            [ModelRequest(parts=[UserPromptPart(content="known balanced request")])]
        )
    )
    return store, history_ref


def test_registered_activity_failure_details_are_bounded_and_secret_free(monkeypatch):
    secret = "provider-secret-never-persist:" + ("x" * (1024 * 1024))

    def fail_read(_scope):
        raise ValueError(secret)

    monkeypatch.setattr(workflow_module, "read_cancellation_request", fail_read)

    with pytest.raises(RuntimeError) as exc_info:
        check_cancellation(FakeActivityContext(), {"scopeId": "scope"})

    details = new_failure_details(exc_info.value)
    assert len(details.errorMessage.encode("utf-8")) <= 256
    assert len(details.stackTrace.value.encode("utf-8")) <= 640
    assert "provider-secret-never-persist" not in details.errorMessage
    assert "provider-secret-never-persist" not in details.stackTrace.value


def test_call_llm_does_not_retry_provider_after_response_media_failure(
    monkeypatch, tmp_path
):
    _configured_history(monkeypatch, tmp_path)
    real_media = workflow_module.durable_media_port(str(tmp_path))
    model = QueuedModel([[TextPart(content="completed once")]])

    class FailingExternalizeMedia:
        async def restore(self, node, **kwargs):
            return await real_media.restore(node, **kwargs)

        async def externalize(self, _node, **_kwargs):
            raise OSError("post-response media write failed")

    monkeypatch.setattr(workflow_module, "build_model", lambda: model)
    monkeypatch.setattr(
        workflow_module,
        "durable_media_port",
        lambda _root: FailingExternalizeMedia(),
    )

    result = call_llm(
        FakeActivityContext(),
        {"task": None, "context": {}, "iteration": 0},
    )

    assert len(model.requests) == 1
    assert result["configurationErrorCode"] == (
        workflow_module.TRANSCRIPT_PERSISTENCE_ERROR
    )
    assert "transcriptStateInvalid" not in result
    assert "historyRef" not in result
    assert "responseRef" not in result


def test_call_llm_does_not_retry_provider_after_response_history_save_failure(
    monkeypatch, tmp_path
):
    store, history_ref = _configured_history(monkeypatch, tmp_path)
    model = QueuedModel([[TextPart(content="completed once")]])
    calls = {"save": 0}

    class FailingSaveHistory:
        def load(self, reference):
            return store.load(reference)

        def save(self, _messages):
            calls["save"] += 1
            raise OSError("post-response manifest write failed")

        def save_message(self, _message):
            raise AssertionError("response blob save must follow manifest save")

    monkeypatch.setattr(workflow_module, "build_model", lambda: model)
    monkeypatch.setattr(
        workflow_module,
        "durable_history_port",
        lambda _root: FailingSaveHistory(),
    )

    result = call_llm(
        FakeActivityContext(),
        {"historyRef": history_ref, "context": {}, "iteration": 1},
    )

    assert len(model.requests) == 1
    assert calls["save"] == 1
    assert result["configurationErrorCode"] == (
        workflow_module.TRANSCRIPT_PERSISTENCE_ERROR
    )
    assert result["historyRef"] == history_ref
    assert "responseRef" not in result


def test_terminal_provider_failure_survives_configuration_history_io_failure(
    monkeypatch, tmp_path
):
    _, history_ref = _configured_history(monkeypatch, tmp_path)
    real_media = workflow_module.durable_media_port(str(tmp_path))

    class TerminalProviderError(Exception):
        status_code = 400

    class RejectingModel:
        model_name = "kimi-k3"

        def __init__(self):
            self.calls = 0

        async def request(self, messages, model_settings, model_request_parameters):
            del messages, model_settings, model_request_parameters
            self.calls += 1
            raise TerminalProviderError("invalid request")

    class FailingExternalizeMedia:
        async def restore(self, node, **kwargs):
            return await real_media.restore(node, **kwargs)

        async def externalize(self, _node, **_kwargs):
            raise OSError("cannot persist terminal provider history")

    model = RejectingModel()
    monkeypatch.setattr(workflow_module, "build_model", lambda: model)
    monkeypatch.setattr(
        workflow_module,
        "durable_media_port",
        lambda _root: FailingExternalizeMedia(),
    )

    result = call_llm(
        FakeActivityContext(),
        {"historyRef": history_ref, "context": {}, "iteration": 1},
    )

    assert model.calls == 1
    assert result["configurationErrorCode"] == (
        workflow_module.MODEL_PROVIDER_REQUEST_ERROR
    )
    assert result["historyRef"] == history_ref
    assert "transcriptStateInvalid" not in result


def test_missing_key_failure_survives_configuration_history_io_failure(
    monkeypatch, tmp_path
):
    _, history_ref = _configured_history(monkeypatch, tmp_path)
    real_media = workflow_module.durable_media_port(str(tmp_path))
    build_calls = {"count": 0}

    def missing_key_model():
        build_calls["count"] += 1
        raise RuntimeError("KIMI_API_KEY is required")

    class FailingExternalizeMedia:
        async def restore(self, node, **kwargs):
            return await real_media.restore(node, **kwargs)

        async def externalize(self, _node, **_kwargs):
            raise OSError("cannot persist missing-key history")

    monkeypatch.setattr(workflow_module, "build_model", missing_key_model)
    monkeypatch.setattr(
        workflow_module,
        "durable_media_port",
        lambda _root: FailingExternalizeMedia(),
    )

    result = call_llm(
        FakeActivityContext(),
        {"historyRef": history_ref, "context": {}, "iteration": 0},
    )

    assert build_calls["count"] == 1
    assert result["configurationErrorCode"] == workflow_module.MODEL_CONFIGURATION_ERROR
    assert result["historyRef"] == history_ref


def test_call_llm_pre_provider_history_read_io_remains_retryable(monkeypatch, tmp_path):
    model = QueuedModel([[TextPart(content="must not be called")]])
    monkeypatch.setattr(workflow_module, "WORKSPACE_ROOT", str(tmp_path))

    class FailingReadHistory:
        def load(self, _reference):
            raise OSError("pre-provider JuiceFS read failed")

    monkeypatch.setattr(workflow_module, "build_model", lambda: model)
    monkeypatch.setattr(
        workflow_module,
        "durable_history_port",
        lambda _root: FailingReadHistory(),
    )

    with pytest.raises(
        RuntimeError,
        match="call_llm failed before returning a durable result",
    ):
        call_llm(
            FakeActivityContext(),
            {
                "historyRef": "history+sha256://" + ("0" * 64),
                "context": {},
                "iteration": 0,
            },
        )
    assert model.requests == []
