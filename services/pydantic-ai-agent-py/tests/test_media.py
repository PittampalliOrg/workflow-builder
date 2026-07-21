"""Native vision input and durable media externalization."""

from __future__ import annotations

import asyncio
import json
import os

import pytest
from PIL import Image
from pydantic_ai.messages import BinaryContent, ModelResponse, TextPart, ToolCallPart

import src.toolsets as toolsets_mod
import src.workflow as wfmod
from src.adapters.harness_durable_media import HarnessDurableMediaAdapter
from src.composition import durable_media_port, workspace_image_port
from src.messages_io import tool_return_message
from src.toolsets import ToolRouter
from src.workflow import call_llm, execute_tool


class FakeActivityCtx:
    workflow_id = "wf-media"
    task_id = 1


def _configure_workspace(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(toolsets_mod, "WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr(wfmod, "WORKSPACE_ROOT", str(tmp_path))
    toolsets_mod._ROUTERS.clear()
    durable_media_port.cache_clear()
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


def test_harness_adapter_restores_only_latest_visual_results(tmp_path):
    tool_messages = [
        tool_return_message(
            "ReadMediaFile",
            f"media-{index}",
            [f"screenshot {index}", BinaryContent(data=bytes([index]), media_type="image/png")],
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


def test_read_media_file_rejects_video_without_files_endpoint(monkeypatch, tmp_path):
    _configure_workspace(monkeypatch, tmp_path)
    (tmp_path / "clip.mp4").write_bytes(b"video")
    router = ToolRouter({"tools": ["ReadMediaFile"]})

    result = asyncio.run(router.call("ReadMediaFile", {"path": "clip.mp4"}))

    assert "Files endpoint" in result
