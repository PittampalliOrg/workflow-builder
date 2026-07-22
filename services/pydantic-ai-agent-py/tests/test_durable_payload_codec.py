from __future__ import annotations

import json

from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

import src.toolsets as toolsets_mod
import src.workflow as workflow_mod
from src.adapters.dapr_durable_payload_codec import DaprDurablePayloadCodecAdapter
from src.composition import durable_history_port
from src.messages_io import dump_messages, load_messages
from src.workflow import (
    DURABLE_WORKFLOW_PAYLOAD_ERROR,
    EXECUTE_TOOL_ARGS_PAYLOAD_ERROR,
    TOOL_RESULT_DURABLE_PAYLOAD_ERROR,
    TOOL_RESULT_SERIALIZATION_ERROR,
    execute_tool,
    fit_call_llm_activity_result,
    fit_execute_tool_activity_input,
    fit_execute_tool_activity_result,
    fit_workflow_activity_input,
    fit_workflow_terminal_result,
    split_workflow_activity_batches,
)


class FakeActivityCtx:
    workflow_id = "wf-1"
    task_id = 1


def _stored_tool_call(
    tmp_path,
    *,
    tool_name: str,
    tool_call_id: str,
    args: dict | None = None,
):
    durable_history_port.cache_clear()
    store = durable_history_port(str(tmp_path))
    response = dump_messages(
        [
            ModelResponse(
                parts=[
                    ToolCallPart(
                        tool_name=tool_name,
                        args=args or {},
                        tool_call_id=tool_call_id,
                    )
                ]
            )
        ]
    )[0]
    return store, store.save_message(response)


def test_dapr_codec_matches_actual_ascii_escaped_transport_json():
    codec = DaprDurablePayloadCodecAdapter()
    payload = {"messages": ["汉", "😀"], "toolCalls": [], "text": "done"}

    assert codec.size_bytes(payload) == len(json.dumps(payload).encode("utf-8"))
    assert codec.size_bytes(payload) > len(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )


def test_complete_activity_result_compacts_against_dapr_wire_size(monkeypatch):
    codec = DaprDurablePayloadCodecAdapter()
    monkeypatch.setattr(workflow_mod, "DURABLE_ACTIVITY_MAX_BYTES", 10_000)
    monkeypatch.setattr(workflow_mod, "DURABLE_HISTORY_MAX_BYTES", 9_000)
    monkeypatch.setattr(workflow_mod, "DURABLE_HISTORY_KEEP_BYTES", 8_000)
    messages = dump_messages(
        [ModelResponse(parts=[ThinkingPart(content="汉" * 1_000)]) for _ in range(5)]
    )

    result = fit_call_llm_activity_result(
        messages=messages,
        tool_calls=[],
        text="done",
        payload_size_bytes=codec.size_bytes,
    )

    assert codec.size_bytes(result) <= 10_000
    assert len(result["messages"]) == 1


def test_oversized_non_history_envelope_returns_typed_terminal_failure(monkeypatch):
    codec = DaprDurablePayloadCodecAdapter()
    monkeypatch.setattr(workflow_mod, "DURABLE_ACTIVITY_MAX_BYTES", 1_000)

    result = fit_call_llm_activity_result(
        messages=[],
        tool_calls=[],
        text="😀" * 1_000,
        payload_size_bytes=codec.size_bytes,
    )

    assert result["configurationErrorCode"] == DURABLE_WORKFLOW_PAYLOAD_ERROR
    assert result["messages"] == []
    assert result["toolCalls"] == []
    assert codec.size_bytes(result) <= 1_000


def test_execute_tool_bounds_nested_json_when_overflow_is_disabled(
    monkeypatch, tmp_path
):
    codec = DaprDurablePayloadCodecAdapter()
    monkeypatch.setattr(workflow_mod, "DURABLE_ACTIVITY_MAX_BYTES", 4_000)
    monkeypatch.setattr(workflow_mod, "WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr(toolsets_mod, "WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr(toolsets_mod, "OVERFLOW_ENABLED", False)
    router = toolsets_mod.ToolRouter({})

    async def large_nested_result(_name, _args):
        return {
            "pages": [
                {"nodes": [{"text": "x" * 1_000} for _ in range(20)]} for _ in range(10)
            ]
        }

    monkeypatch.setattr(router, "call", large_nested_result)
    monkeypatch.setattr(workflow_mod, "get_router", lambda _config: router)

    result = execute_tool(
        FakeActivityCtx(),
        {
            "call": {"toolName": "inspect_dom", "toolCallId": "tc-big", "args": {}},
            "context": {},
            "iteration": 0,
        },
    )

    assert codec.size_bytes(result) <= 4_000
    assert result["toolSucceeded"] is False
    assert result["toolErrorCode"] == TOOL_RESULT_DURABLE_PAYLOAD_ERROR
    part = load_messages([result["message"]])[0].parts[0]
    assert part.tool_call_id == "tc-big"
    assert "smaller chunks" in str(part.content)


def test_execute_tool_bounds_raw_result_after_overflow_hook_failure(
    monkeypatch, tmp_path
):
    codec = DaprDurablePayloadCodecAdapter()
    monkeypatch.setattr(workflow_mod, "DURABLE_ACTIVITY_MAX_BYTES", 4_000)
    monkeypatch.setattr(workflow_mod, "WORKSPACE_ROOT", str(tmp_path))

    class FailingOverflowRouter:
        async def call(self, _name, _args):
            return [{"chunk": "x" * 20_000} for _ in range(10)]

        async def apply_after_tool_execute(self, **_kwargs):
            raise RuntimeError("overflow store unavailable")

    monkeypatch.setattr(
        workflow_mod, "get_router", lambda _config: FailingOverflowRouter()
    )

    result = execute_tool(
        FakeActivityCtx(),
        {
            "call": {"toolName": "remote_read", "toolCallId": "tc-fail", "args": {}},
            "context": {},
            "iteration": 0,
        },
    )

    assert codec.size_bytes(result) <= 4_000
    assert result["toolSucceeded"] is False
    assert result["toolErrorCode"] == TOOL_RESULT_DURABLE_PAYLOAD_ERROR
    assert load_messages([result["message"]])[0].parts[0].tool_call_id == "tc-fail"


def test_execute_tool_ref_path_bounds_result_when_overflow_hook_fails(
    monkeypatch, tmp_path
):
    codec = DaprDurablePayloadCodecAdapter()
    monkeypatch.setattr(workflow_mod, "WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr(workflow_mod, "TRANSCRIPT_KEEP_BYTES", 2_000)
    store, response_ref = _stored_tool_call(
        tmp_path,
        tool_name="remote_read",
        tool_call_id="tc-ref-overflow",
    )

    class FailingOverflowRouter:
        async def call(self, _name, _args):
            return [{"chunk": "x" * 20_000} for _ in range(10)]

        async def apply_after_tool_execute(self, **_kwargs):
            raise RuntimeError("overflow store unavailable")

    monkeypatch.setattr(
        workflow_mod, "get_router", lambda _config: FailingOverflowRouter()
    )

    result = execute_tool(
        FakeActivityCtx(),
        {
            "call": {
                "toolName": "remote_read",
                "toolCallId": "tc-ref-overflow",
                "responseRef": response_ref,
                "toolIndex": 0,
            },
            "context": {},
            "iteration": 0,
        },
    )

    assert codec.size_bytes(result) <= workflow_mod.DURABLE_ACTIVITY_MAX_BYTES
    assert "message" not in result
    assert result["toolSucceeded"] is False
    assert result["toolErrorCode"] == TOOL_RESULT_DURABLE_PAYLOAD_ERROR
    saved = store.load_message(result["messageRef"])
    part = load_messages([saved])[0].parts[0]
    assert part.tool_call_id == "tc-ref-overflow"
    assert "smaller chunks" in str(part.content)
    assert codec.size_bytes([saved]) <= 2_000


def test_execute_tool_uses_typed_terminal_when_correlation_envelope_cannot_fit(
    monkeypatch,
):
    codec = DaprDurablePayloadCodecAdapter()
    monkeypatch.setattr(workflow_mod, "DURABLE_ACTIVITY_MAX_BYTES", 800)

    result = fit_execute_tool_activity_result(
        message={"raw": "x" * 10_000},
        tool_name="tool",
        tool_call_id="tc" * 2_000,
        tool_error=None,
        structured_output_attempt=False,
        structured_output=None,
        payload_size_bytes=codec.size_bytes,
    )

    assert codec.size_bytes(result) <= 800
    assert result["message"] is None
    assert result["configurationErrorCode"] == TOOL_RESULT_DURABLE_PAYLOAD_ERROR


def test_execute_tool_converts_non_serializable_result_to_correlated_error(
    monkeypatch, tmp_path
):
    codec = DaprDurablePayloadCodecAdapter()
    monkeypatch.setattr(workflow_mod, "WORKSPACE_ROOT", str(tmp_path))

    class NonSerializableRouter:
        async def call(self, _name, _args):
            return {"nested": {"value": object()}}

        async def apply_after_tool_execute(self, **kwargs):
            return kwargs["result"]

    monkeypatch.setattr(
        workflow_mod, "get_router", lambda _config: NonSerializableRouter()
    )

    result = execute_tool(
        FakeActivityCtx(),
        {
            "call": {
                "toolName": "inspect_dom",
                "toolCallId": "tc-not-json",
                "args": {},
            },
            "context": {},
            "iteration": 0,
        },
    )

    assert codec.size_bytes(result) <= workflow_mod.DURABLE_ACTIVITY_MAX_BYTES
    assert result["toolSucceeded"] is False
    assert result["toolErrorCode"] == TOOL_RESULT_SERIALIZATION_ERROR
    part = load_messages([result["message"]])[0].parts[0]
    assert part.tool_call_id == "tc-not-json"
    assert "JSON-compatible" in str(part.content)


def test_execute_tool_ref_path_converts_cyclic_result_to_correlated_error(
    monkeypatch, tmp_path
):
    codec = DaprDurablePayloadCodecAdapter()
    monkeypatch.setattr(workflow_mod, "WORKSPACE_ROOT", str(tmp_path))
    store, response_ref = _stored_tool_call(
        tmp_path,
        tool_name="inspect_dom",
        tool_call_id="tc-ref-cycle",
    )

    class CyclicResultRouter:
        async def call(self, _name, _args):
            result: dict[str, object] = {"label": "cycle"}
            result["nested"] = result
            return result

        async def apply_after_tool_execute(self, **kwargs):
            return kwargs["result"]

    monkeypatch.setattr(
        workflow_mod, "get_router", lambda _config: CyclicResultRouter()
    )

    result = execute_tool(
        FakeActivityCtx(),
        {
            "call": {
                "toolName": "inspect_dom",
                "toolCallId": "tc-ref-cycle",
                "responseRef": response_ref,
                "toolIndex": 0,
            },
            "context": {},
            "iteration": 0,
        },
    )

    assert codec.size_bytes(result) <= workflow_mod.DURABLE_ACTIVITY_MAX_BYTES
    assert "message" not in result
    assert result["toolSucceeded"] is False
    assert result["toolErrorCode"] == TOOL_RESULT_SERIALIZATION_ERROR
    saved = store.load_message(result["messageRef"])
    part = load_messages([saved])[0].parts[0]
    assert part.tool_call_id == "tc-ref-cycle"
    assert "JSON-compatible" in str(part.content)


def test_execute_tool_ref_path_reapplies_structured_output_argument_cap(
    monkeypatch, tmp_path
):
    oversized_args = {
        "summary": "é" * (workflow_mod.STRUCTURED_OUTPUT_MAX_BYTES // 2)
    }
    encoded_size = len(
        json.dumps(oversized_args, ensure_ascii=False, allow_nan=False).encode()
    )
    assert encoded_size > workflow_mod.STRUCTURED_OUTPUT_MAX_BYTES

    monkeypatch.setattr(workflow_mod, "WORKSPACE_ROOT", str(tmp_path))
    store, response_ref = _stored_tool_call(
        tmp_path,
        tool_name="StructuredOutput",
        tool_call_id="tc-ref-structured-cap",
        args=oversized_args,
    )
    context = {
        "agentConfig": {
            "structuredOutputMode": "tool",
            "responseJsonSchema": {
                "type": "object",
                "required": ["summary"],
                "properties": {"summary": {"type": "string"}},
            },
        }
    }
    captured: dict[str, object] = {}
    real_evaluate_call = workflow_mod.evaluate_call

    def capture_evaluate_call(schema, args, *, args_error=None):
        captured["args"] = args
        captured["argsError"] = args_error
        return real_evaluate_call(schema, args, args_error=args_error)

    monkeypatch.setattr(workflow_mod, "evaluate_call", capture_evaluate_call)

    result = execute_tool(
        FakeActivityCtx(),
        {
            "call": {
                "toolName": "StructuredOutput",
                "toolCallId": "tc-ref-structured-cap",
                "argsSizeBytes": encoded_size,
                "argsError": "original call_llm cap",
                "responseRef": response_ref,
                "toolIndex": 0,
                "isStructuredOutput": True,
            },
            "context": context,
            "iteration": 0,
        },
    )

    assert captured["args"] == {}
    assert f"maximum is {workflow_mod.STRUCTURED_OUTPUT_MAX_BYTES}" in str(
        captured["argsError"]
    )
    assert result["toolSucceeded"] is False
    assert result["structuredOutputAttempt"] is True
    assert result["structuredOutput"] is None
    saved = store.load_message(result["messageRef"])
    part = load_messages([saved])[0].parts[0]
    assert part.tool_call_id == "tc-ref-structured-cap"
    assert f"maximum is {workflow_mod.STRUCTURED_OUTPUT_MAX_BYTES}" in str(
        part.content
    )


def test_execute_tool_returns_terminal_after_post_effect_media_io_failure(
    monkeypatch, tmp_path
):
    calls = {"router": 0}

    class Router:
        async def call(self, _name, _args):
            calls["router"] += 1
            return "image result"

        async def apply_after_tool_execute(self, **kwargs):
            return kwargs["result"]

    class FailingMedia:
        async def externalize(self, _messages, **_kwargs):
            raise OSError("workspace temporarily unavailable")

    monkeypatch.setattr(workflow_mod, "WORKSPACE_ROOT", str(tmp_path))
    _, response_ref = _stored_tool_call(
        tmp_path,
        tool_name="screenshot",
        tool_call_id="tc-io",
    )
    monkeypatch.setattr(workflow_mod, "get_router", lambda _config: Router())
    monkeypatch.setattr(
        workflow_mod, "durable_media_port", lambda _root: FailingMedia()
    )

    result = execute_tool(
        FakeActivityCtx(),
        {
            "call": {
                "toolName": "screenshot",
                "toolCallId": "tc-io",
                "responseRef": response_ref,
                "toolIndex": 0,
            },
            "context": {},
            "iteration": 0,
        },
    )

    assert calls["router"] == 1
    assert result["configurationErrorCode"] == (
        workflow_mod.TRANSCRIPT_PERSISTENCE_ERROR
    )
    assert "transcriptStateInvalid" not in result
    assert "messageRef" not in result


def test_execute_tool_returns_terminal_after_post_effect_history_save_failure(
    monkeypatch, tmp_path
):
    calls = {"router": 0, "save": 0}
    monkeypatch.setattr(workflow_mod, "WORKSPACE_ROOT", str(tmp_path))
    store, response_ref = _stored_tool_call(
        tmp_path,
        tool_name="remote_write",
        tool_call_id="tc-save-io",
    )

    class Router:
        async def call(self, _name, _args):
            calls["router"] += 1
            return "write completed"

        async def apply_after_tool_execute(self, **kwargs):
            return kwargs["result"]

    class FailingSaveHistory:
        def load_message(self, reference):
            return store.load_message(reference)

        def save_message(self, _message):
            calls["save"] += 1
            raise OSError("JuiceFS write temporarily unavailable")

    monkeypatch.setattr(workflow_mod, "get_router", lambda _config: Router())
    monkeypatch.setattr(
        workflow_mod,
        "durable_history_port",
        lambda _root: FailingSaveHistory(),
    )

    result = execute_tool(
        FakeActivityCtx(),
        {
            "call": {
                "toolName": "remote_write",
                "toolCallId": "tc-save-io",
                "responseRef": response_ref,
                "toolIndex": 0,
            },
            "context": {},
            "iteration": 0,
        },
    )

    assert calls == {"router": 1, "save": 1}
    assert result["configurationErrorCode"] == (
        workflow_mod.TRANSCRIPT_PERSISTENCE_ERROR
    )
    assert "transcriptStateInvalid" not in result
    assert "messageRef" not in result


def test_call_llm_input_compacts_complete_envelope_and_preserves_tool_pairs(
    monkeypatch,
):
    codec = DaprDurablePayloadCodecAdapter()
    monkeypatch.setattr(workflow_mod, "DURABLE_ACTIVITY_MAX_BYTES", 7_000)
    monkeypatch.setattr(workflow_mod, "DURABLE_HISTORY_MAX_BYTES", 6_500)
    monkeypatch.setattr(workflow_mod, "DURABLE_HISTORY_KEEP_BYTES", 6_000)
    messages = dump_messages(
        [
            ModelRequest(parts=[UserPromptPart(content="keep the first request")]),
            ModelResponse(parts=[ThinkingPart(content="old" * 1_500)]),
            ModelResponse(
                parts=[
                    ToolCallPart(tool_name="read", args={}, tool_call_id="tc-1"),
                    ToolCallPart(tool_name="read", args={}, tool_call_id="tc-2"),
                ]
            ),
            ModelRequest(
                parts=[
                    ToolReturnPart(
                        tool_name="read", tool_call_id="tc-1", content="a" * 900
                    )
                ]
            ),
            ModelRequest(
                parts=[
                    ToolReturnPart(
                        tool_name="read", tool_call_id="tc-2", content="b" * 900
                    )
                ]
            ),
        ]
    )
    payload = {
        "task": None,
        "messages": messages,
        "context": {"sessionId": "session-1"},
        "iteration": 3,
    }

    fitted = fit_workflow_activity_input(
        activity_name=workflow_mod.CALL_LLM_ACTIVITY,
        payload=payload,
        payload_size_bytes=codec.size_bytes,
    )

    assert codec.size_bytes(fitted) <= 7_000
    typed = load_messages(fitted["messages"])
    call_ids = [
        part.tool_call_id
        for message in typed
        if isinstance(message, ModelResponse)
        for part in message.parts
        if isinstance(part, ToolCallPart)
    ]
    return_ids = [
        part.tool_call_id
        for message in typed
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    ]
    assert call_ids == return_ids == ["tc-1", "tc-2"]


def test_execute_input_omits_only_oversized_args_from_dispatch_copy(monkeypatch):
    codec = DaprDurablePayloadCodecAdapter()
    monkeypatch.setattr(workflow_mod, "DURABLE_ACTIVITY_MAX_BYTES", 1_200)
    original_call = {
        "toolName": "write_file",
        "toolCallId": "tc-args",
        "args": {"content": "x" * 5_000},
        "sequential": True,
    }

    fitted = fit_execute_tool_activity_input(
        call=original_call,
        context={"sessionId": "session-1"},
        iteration=2,
        payload_size_bytes=codec.size_bytes,
    )

    assert codec.size_bytes(fitted) <= 1_200
    assert fitted["call"]["args"] == {}
    assert fitted["call"]["argsError"] == EXECUTE_TOOL_ARGS_PAYLOAD_ERROR
    assert fitted["call"]["toolCallId"] == "tc-args"
    assert fitted["call"]["sequential"] is True
    assert original_call["args"] == {"content": "x" * 5_000}
    assert "argsError" not in original_call


def test_parallel_activity_batches_are_aggregate_bounded_and_ordered(monkeypatch):
    codec = DaprDurablePayloadCodecAdapter()
    payloads = [
        {
            "call": {"toolName": "read", "toolCallId": f"tc-{index}", "args": {}},
            "context": {"pad": "x" * 250},
            "iteration": 0,
        }
        for index in range(3)
    ]
    two_payload_limit = codec.size_bytes(payloads[:2])
    monkeypatch.setattr(workflow_mod, "DURABLE_ACTIVITY_MAX_BYTES", two_payload_limit)

    batches = split_workflow_activity_batches(
        payloads, payload_size_bytes=codec.size_bytes
    )

    assert [len(batch) for batch in batches] == [2, 1]
    assert [
        payload["call"]["toolCallId"] for batch in batches for payload in batch
    ] == ["tc-0", "tc-1", "tc-2"]
    assert all(codec.size_bytes(batch) <= two_payload_limit for batch in batches)


def test_terminal_fallback_is_bounded_typed_and_keeps_cancellation(monkeypatch):
    codec = DaprDurablePayloadCodecAdapter()
    monkeypatch.setattr(workflow_mod, "DURABLE_ACTIVITY_MAX_BYTES", 900)

    fitted = fit_workflow_terminal_result(
        {
            "role": "assistant",
            "content": "stop" * 2_000,
            "success": False,
            "cancelled": True,
            "error": "stop" * 2_000,
            "stop_reason": {"type": "terminated", "reason": "stop" * 2_000},
            "iterations": 4,
            "messages": dump_messages(
                [ModelResponse(parts=[ThinkingPart(content="history" * 2_000)])]
            ),
        },
        payload_size_bytes=codec.size_bytes,
    )

    assert codec.size_bytes(fitted) <= 900
    assert fitted["errorCode"] == DURABLE_WORKFLOW_PAYLOAD_ERROR
    assert fitted["messages"] == []
    assert fitted["cancelled"] is True
    assert fitted["stop_reason"] == {"type": "terminated"}
