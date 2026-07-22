"""Native vision input and durable media externalization."""

from __future__ import annotations

import asyncio
import base64
import json
import os

import httpx
import pytest
from PIL import Image
from pydantic_ai.messages import (
    BinaryContent,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturn,
    ToolReturnPart,
    UserPromptPart,
)

import src.toolsets as toolsets_mod
import src.workflow as wfmod
from src.adapters.harness_durable_media import HarnessDurableMediaAdapter
from src.composition import durable_history_port, durable_media_port, workspace_image_port
from src.messages_io import dump_messages, tool_return_message
from src.toolsets import ToolRouter
from src.workflow import call_llm, commit_tool_results, execute_tool


class FakeActivityCtx:
    workflow_id = "wf-media"
    task_id = 1


def _configure_workspace(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(toolsets_mod, "WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr(wfmod, "WORKSPACE_ROOT", str(tmp_path))
    toolsets_mod._ROUTERS.clear()
    durable_media_port.cache_clear()
    durable_history_port.cache_clear()
    workspace_image_port.cache_clear()


def test_read_media_file_returns_native_pixels_and_blocks_escape(monkeypatch, tmp_path):
    _configure_workspace(monkeypatch, tmp_path)
    image_path = tmp_path / "screen.png"
    Image.new("RGB", (1800, 900), color=(10, 80, 160)).save(image_path)

    router = ToolRouter({"tools": ["ReadMediaFile"]})
    result = asyncio.run(router.call("ReadMediaFile", {"path": "screen.png"}))

    assert isinstance(result, list)
    assert "1800x900 -> 1568x784" in result[0]
    assert isinstance(result[1], BinaryContent)
    assert result[1].media_type == "image/png"

    outside = tmp_path.parent / "outside.png"
    Image.new("RGB", (10, 10)).save(outside)
    denied = asyncio.run(router.call("ReadMediaFile", {"path": str(outside.resolve())}))
    assert "inside the agent workspace" in denied


def test_harness_adapter_round_trips_binary_without_persisting_pixels(tmp_path):
    binary = BinaryContent(data=b"not-real-png-bytes", media_type="image/png")
    messages = [tool_return_message("ReadMediaFile", "media-1", ["screenshot", binary])]
    adapter = HarnessDurableMediaAdapter(tmp_path)

    externalized = asyncio.run(adapter.externalize(messages))
    durable_json = json.dumps(externalized)
    assert "media+sha256://" in durable_json
    assert binary.base64 not in durable_json

    restored = asyncio.run(adapter.restore(externalized))
    part = restored[0].parts[0]
    assert part.files[0].data == binary.data
    assert part.files[0].media_type == "image/png"


def test_native_tool_return_round_trips_return_and_prompt_media(tmp_path):
    returned_image = BinaryContent(data=b"returned-pixels", media_type="image/png")
    prompt_image = BinaryContent(data=b"prompt-pixels", media_type="image/png")
    message = tool_return_message(
        "capture",
        "capture-1",
        ToolReturn(
            return_value=["captured", returned_image],
            content=["inspect this screenshot", prompt_image],
            metadata={"source": "native-tool-return"},
        ),
    )

    assert isinstance(message.parts[0], ToolReturnPart)
    assert message.parts[0].tool_call_id == "capture-1"
    assert message.parts[0].metadata == {"source": "native-tool-return"}
    assert message.parts[0].files == [returned_image]
    assert isinstance(message.parts[1], UserPromptPart)
    assert message.parts[1].content == ["inspect this screenshot", prompt_image]

    adapter = HarnessDurableMediaAdapter(tmp_path)
    externalized = asyncio.run(adapter.externalize([message]))
    durable_json = json.dumps(externalized)
    assert returned_image.base64 not in durable_json
    assert prompt_image.base64 not in durable_json
    assert durable_json.count("media+sha256://") == 2

    restored = asyncio.run(adapter.restore(externalized))
    return_part, prompt_part = restored[0].parts
    assert return_part.files[0].data == returned_image.data
    assert prompt_part.content[1].data == prompt_image.data


def test_tool_return_message_does_not_pretruncate_below_overflow_threshold():
    content = "x" * 9_000

    message = tool_return_message("read_file", "text-1", content)

    assert message.parts[0].content == content


def test_harness_adapter_restores_only_latest_visual_results(tmp_path):
    tool_messages = [
        tool_return_message(
            "ReadMediaFile",
            f"media-{index}",
            [
                f"screenshot {index}",
                BinaryContent(data=bytes([index]), media_type="image/png"),
            ],
        )
        for index in range(1, 6)
    ]
    messages = [
        ModelResponse(
            parts=[
                ToolCallPart(
                    tool_name="ReadMediaFile",
                    args={"path": f"screen-{index}.png"},
                    tool_call_id=f"media-{index}",
                )
                for index in range(1, 6)
            ]
        ),
        *tool_messages,
    ]
    adapter = HarnessDurableMediaAdapter(tmp_path)
    externalized = asyncio.run(adapter.externalize(messages))

    first_request = asyncio.run(adapter.restore(externalized, max_media_items=2))
    assert sum(bool(message.parts[0].files) for message in first_request[1:]) == 5

    presented = [*first_request, ModelResponse(parts=[TextPart(content="reviewed")])]
    durable_presented = asyncio.run(adapter.externalize(presented))
    restored = asyncio.run(adapter.restore(durable_presented, max_media_items=2))
    parts = [message.parts[0] for message in restored[1:6]]

    assert sum(bool(part.files) for part in parts) == 2
    assert all(not part.files for part in parts[:3])
    assert all("originating media tool" in str(part.content) for part in parts[:3])


def test_harness_adapter_does_not_treat_ordinary_tool_json_as_media(tmp_path):
    ordinary = {
        "kind": "binary",
        "data": "plain text",
        "__wfb_external_media_v1__": {"uri": "not-a-media-uri"},
    }
    message = tool_return_message("mcp_tool", "json-1", ordinary)
    adapter = HarnessDurableMediaAdapter(tmp_path)

    externalized = asyncio.run(adapter.externalize([message]))
    restored = asyncio.run(adapter.restore(externalized))

    assert restored[0].parts[0].content == ordinary


def test_harness_adapter_escapes_exact_internal_sentinel_shaped_tool_json(tmp_path):
    ordinary = {
        "url": "media+sha256://" + ("a" * 64),
        "force_download": False,
        "vendor_metadata": {
            "__wfb_external_media_v1__": {
                "size_bytes": 4,
                "vendor_metadata": {"from": "ordinary-tool-json"},
            }
        },
        "kind": "image-url",
        "media_type": "image/png",
        "identifier": "ordinary-json",
    }
    message = tool_return_message("mcp_tool", "json-sentinel-1", ordinary)
    adapter = HarnessDurableMediaAdapter(tmp_path)

    externalized = asyncio.run(adapter.externalize([message]))
    assert "__wfb_escaped_media_json_v1__" in json.dumps(externalized)
    restored = asyncio.run(adapter.restore(externalized))
    assert restored[0].parts[0].content == ordinary

    # Commit-style serialization of already externalized records is idempotent.
    reloaded = wfmod.load_messages(externalized)
    second = asyncio.run(
        adapter.externalize(reloaded, preserve_references=True)
    )
    assert second == externalized
    assert asyncio.run(adapter.restore(second))[0].parts[0].content == ordinary


def test_commit_preserves_escaped_tool_json_across_multiple_waves(
    monkeypatch, tmp_path
):
    _configure_workspace(monkeypatch, tmp_path)
    ordinary = {
        "url": "media+sha256://" + ("b" * 64),
        "force_download": False,
        "vendor_metadata": {
            "__wfb_external_media_v1__": {
                "size_bytes": 8,
                "vendor_metadata": None,
            }
        },
        "kind": "image-url",
        "media_type": "image/png",
        "identifier": "ordinary-two-wave-json",
    }
    store = durable_history_port(str(tmp_path))
    media = durable_media_port(str(tmp_path))

    first_response = ModelResponse(
        parts=[ToolCallPart(tool_name="first", args={}, tool_call_id="first-1")]
    )
    first_history_ref = store.save(dump_messages([first_response]))
    first_return = asyncio.run(
        media.externalize([tool_return_message("first", "first-1", ordinary)])
    )[0]
    first_commit = commit_tool_results(
        FakeActivityCtx(),
        {
            "historyRef": first_history_ref,
            "messageRefs": [store.save_message(first_return)],
        },
    )
    first_escape_count = json.dumps(store.load(first_commit["historyRef"])).count(
        "__wfb_escaped_media_json_v1__"
    )
    assert first_escape_count >= 1

    second_response = ModelResponse(
        parts=[ToolCallPart(tool_name="second", args={}, tool_call_id="second-1")]
    )
    second_response_json = dump_messages([second_response])[0]
    second_history_ref = store.save(
        [*store.load(first_commit["historyRef"]), second_response_json]
    )
    second_return = asyncio.run(
        media.externalize(
            [tool_return_message("second", "second-1", {"ok": True})]
        )
    )[0]
    second_commit = commit_tool_results(
        FakeActivityCtx(),
        {
            "historyRef": second_history_ref,
            "messageRefs": [store.save_message(second_return)],
        },
    )

    durable = store.load(second_commit["historyRef"])
    assert (
        json.dumps(durable).count("__wfb_escaped_media_json_v1__")
        == first_escape_count
    )
    restored = asyncio.run(media.restore(durable))
    first_tool_return = next(
        part
        for message in restored
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart) and part.tool_call_id == "first-1"
    )
    assert first_tool_return.content == ordinary


def test_harness_adapter_bounds_unseen_media_with_model_visible_error(tmp_path):
    messages = [
        tool_return_message(
            "ReadMediaFile",
            f"unseen-{index}",
            [BinaryContent(data=bytes([index]) * 4, media_type="image/png")],
        )
        for index in range(1, 4)
    ]
    adapter = HarnessDurableMediaAdapter(tmp_path)
    externalized = asyncio.run(adapter.externalize(messages))

    restored = asyncio.run(
        adapter.restore(
            externalized,
            max_media_items=1,
            max_request_images=2,
            max_request_bytes=8,
        )
    )
    parts = [message.parts[0] for message in restored]

    assert sum(bool(part.files) for part in parts) == 2
    assert "aggregate media limit" in str(parts[2].content)


def test_harness_adapter_rejects_tampered_content_addressed_blob(tmp_path):
    binary = BinaryContent(data=b"trusted pixels", media_type="image/png")
    message = tool_return_message("ReadMediaFile", "media-integrity", [binary])
    adapter = HarnessDurableMediaAdapter(tmp_path)
    externalized = asyncio.run(adapter.externalize([message]))
    durable_json = json.dumps(externalized)
    digest = durable_json.split("media+sha256://", 1)[1].split('"', 1)[0]
    blob = tmp_path / ".pydantic-ai" / "media" / f"{digest}.bin"
    blob.write_bytes(b"tampered pixels")

    with pytest.raises(ValueError, match="check failed"):
        asyncio.run(adapter.restore(externalized))


def test_execute_tool_externalizes_then_call_llm_restores_media(monkeypatch, tmp_path):
    _configure_workspace(monkeypatch, tmp_path)
    image_path = tmp_path / "screen.png"
    # Incompressible pixels ensure the payload is well above the overflow
    # capability's 10 KB band. Media must bypass text overflow and survive.
    Image.frombytes("RGB", (256, 256), os.urandom(256 * 256 * 3)).save(image_path)

    tool_out = execute_tool(
        FakeActivityCtx(),
        {
            "call": {
                "toolName": "ReadMediaFile",
                "toolCallId": "media-2",
                "args": {"path": "screen.png"},
            },
            "context": {"agentConfig": {"tools": ["ReadMediaFile"]}},
            "iteration": 0,
        },
    )
    durable_json = json.dumps(tool_out["message"])
    assert "media+sha256://" in durable_json
    assert "iVBOR" not in durable_json
    assert ".overflow" not in durable_json

    captured: dict = {}

    class FakeModel:
        model_name = "kimi-k3"

        async def request(self, messages, model_settings, model_request_parameters):
            captured["messages"] = list(messages)
            from pydantic_ai.messages import ModelResponse
            from pydantic_ai.usage import RequestUsage

            return ModelResponse(
                parts=[TextPart(content="I can see the image")],
                usage=RequestUsage(input_tokens=10, output_tokens=5),
                model_name="kimi-k3",
            )

    monkeypatch.setattr(wfmod, "build_model", lambda: FakeModel())
    out = call_llm(
        FakeActivityCtx(),
        {
            "messages": [tool_out["message"]],
            "context": {"agentConfig": {"tools": ["ReadMediaFile"]}},
            "iteration": 1,
        },
    )

    restored_part = captured["messages"][0].parts[0]
    assert restored_part.files
    assert restored_part.files[0].media_type == "image/png"
    assert "media+sha256://" in json.dumps(out["messages"])


def test_native_tool_return_media_survives_execute_commit_and_next_model(
    monkeypatch, tmp_path
):
    _configure_workspace(monkeypatch, tmp_path)
    pixels = b"native-tool-return-pixels"
    old_pixels = b"prior-history-pixels"
    prior_call = ModelResponse(
        parts=[
            ToolCallPart(
                tool_name="capture",
                args={},
                tool_call_id="capture-prior-1",
            )
        ]
    )
    prior_return = tool_return_message(
        "capture",
        "capture-prior-1",
        ["prior capture", BinaryContent(data=old_pixels, media_type="image/png")],
    )
    assistant = ModelResponse(
        parts=[
            ToolCallPart(
                tool_name="capture",
                args={},
                tool_call_id="capture-native-1",
            )
        ]
    )
    store = durable_history_port(str(tmp_path))
    media = durable_media_port(str(tmp_path))
    durable_history = asyncio.run(
        media.externalize(
            [
                prior_call,
                prior_return,
                ModelResponse(parts=[TextPart(content="prior capture reviewed")]),
                assistant,
            ]
        )
    )
    assistant_history_ref = store.save(durable_history)
    response_ref = store.save_message(durable_history[-1])

    class NativeReturnRouter:
        async def call(self, _name, _args):
            return ToolReturn(
                return_value={"captured": True},
                content=[
                    "inspect the captured pixels",
                    BinaryContent(data=pixels, media_type="image/png"),
                ],
            )

    monkeypatch.setattr(wfmod, "get_router", lambda _config: NativeReturnRouter())
    tool_out = execute_tool(
        FakeActivityCtx(),
        {
            "call": {
                "responseRef": response_ref,
                "toolIndex": 0,
                "sequential": False,
                "isStructuredOutput": False,
            },
            "context": {},
            "iteration": 0,
        },
    )
    assert set(tool_out) >= {"messageRef", "toolSucceeded"}
    assert "media+sha256://" in json.dumps(store.load_message(tool_out["messageRef"]))

    blob_reads: list[str] = []
    real_get = media._store.get

    async def reject_blob_read(uri):
        blob_reads.append(uri)
        raise AssertionError("commit_tool_results must not hydrate media blobs")

    monkeypatch.setattr(media._store, "get", reject_blob_read)
    committed = commit_tool_results(
        FakeActivityCtx(),
        {
            "historyRef": assistant_history_ref,
            "messageRefs": [tool_out["messageRef"]],
        },
    )
    assert set(committed) == {"historyRef"}
    assert blob_reads == []
    monkeypatch.setattr(media._store, "get", real_get)

    captured_wire: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_wire.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-full-media-path",
                "object": "chat.completion",
                "created": 1,
                "model": "kimi-k3",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": "pixels received",
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            },
        )

    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model = OpenAIChatModel(
        "kimi-k3",
        provider=OpenAIProvider(
            base_url="https://api.kimi.com/coding/v1",
            api_key="wire-test-key",
            http_client=http_client,
        ),
        profile=wfmod._kimi_model_profile,
    )
    monkeypatch.setattr(wfmod, "get_router", lambda config: ToolRouter(config))
    monkeypatch.setattr(wfmod, "build_model", lambda: model)
    monkeypatch.setattr(wfmod, "KIMI_STREAMING_ENABLED", False)
    result = call_llm(
        FakeActivityCtx(),
        {"historyRef": committed["historyRef"], "context": {}, "iteration": 1},
    )
    asyncio.run(http_client.aclose())

    committed_request = wfmod.load_messages(store.load(committed["historyRef"]))[-1]
    assert isinstance(committed_request, ModelRequest)
    assert isinstance(committed_request.parts[0], ToolReturnPart)
    new_return = committed_request.parts[-2]
    new_prompt = committed_request.parts[-1]
    assert isinstance(new_return, ToolReturnPart)
    assert isinstance(new_prompt, UserPromptPart)
    image_urls = [
        part["image_url"]["url"]
        for message in captured_wire["messages"]
        if isinstance(message.get("content"), list)
        for part in message["content"]
        if part.get("type") == "image_url"
    ]
    expected_url = "data:image/png;base64," + base64.b64encode(pixels).decode()
    assert expected_url in image_urls
    assert all(not url.startswith("media+sha256://") for url in image_urls)
    assert result["text"] == "pixels received"


def test_read_media_file_rejects_video_without_files_endpoint(monkeypatch, tmp_path):
    _configure_workspace(monkeypatch, tmp_path)
    (tmp_path / "clip.mp4").write_bytes(b"video")
    router = ToolRouter({"tools": ["ReadMediaFile"]})

    result = asyncio.run(router.call("ReadMediaFile", {"path": "clip.mp4"}))

    assert "Files endpoint" in result
