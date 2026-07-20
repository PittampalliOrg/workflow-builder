from __future__ import annotations

import base64
import json

from dapr_agents.tool.utils.serialization import serialize_tool_result
from mcp.types import CallToolResult, ImageContent, TextContent

from src.compaction.payloads import compact_save_tool_results_payload
from src.kimi_adapter import _normalize_messages_for_kimi
from src.mcp_multimodal import (
    decode_multimodal_tool_content,
    offload_multimodal_tool_result,
    redact_multimodal_tool_result,
    serialize_mcp_tool_result,
)
from src.ports.multimodal_media import OffloadedMediaReference


class _RecordingMediaOffloader:
    def __init__(self) -> None:
        self.uploads: list[tuple[bytes, str]] = []

    def upload_image(
        self,
        image: bytes,
        media_type: str,
        *,
        label: str | None = None,
    ) -> OffloadedMediaReference:
        del label
        self.uploads.append((image, media_type))
        return OffloadedMediaReference(
            uri=f"ms://file-{len(self.uploads)}",
            provider="test",
            file_id=f"file-{len(self.uploads)}",
            media_type=media_type,
            size_bytes=len(image),
            sha256="test-sha",
        )


def _screenshot_result(data: str = "SCREENSHOT_BYTES") -> CallToolResult:
    return CallToolResult(
        content=[
            TextContent(type="text", text="Screenshot captured"),
            ImageContent(type="image", data=data, mimeType="image/png"),
        ],
        isError=False,
    )


def test_real_mcp_call_tool_result_survives_tool_message_string_seam() -> None:
    result = _screenshot_result()

    # dapr-agents 1.0.4's generic serializer is the runtime seam that used to
    # turn the whole CallToolResult into an opaque JSON string. The provider
    # adapter consequently received screenshot metadata/base64 as prompt text.
    upstream_serialized = serialize_tool_result(result)
    assert isinstance(upstream_serialized, str)
    assert "SCREENSHOT_BYTES" in upstream_serialized
    assert decode_multimodal_tool_content(upstream_serialized) is None

    serialized = serialize_mcp_tool_result(result, serialize_tool_result)
    assert serialized.display_text == "Screenshot captured"
    assert serialized.is_multimodal
    assert serialized.durable_content.count("SCREENSHOT_BYTES") == 1

    messages = _normalize_messages_for_kimi(
        None,
        [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "shot_1",
                        "type": "function",
                        "function": {"name": "browser_screenshot", "arguments": "{}"},
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "shot_1",
                "content": serialized.durable_content,
            },
        ],
    )

    assert messages[1] == {
        "role": "tool",
        "tool_call_id": "shot_1",
        "content": "Screenshot captured",
    }
    assert messages[2]["role"] == "user"
    assert messages[2]["content"][1] == {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64,SCREENSHOT_BYTES"},
    }


def test_payload_compaction_does_not_destroy_current_visual_result() -> None:
    serialized = serialize_mcp_tool_result(
        _screenshot_result("A" * 20_000), serialize_tool_result
    )
    payload = {
        "tool_results": [
            {
                "role": "tool",
                "tool_call_id": "shot_1",
                "content": serialized.durable_content,
            }
        ],
        "tool_calls_by_id": {},
    }

    compacted, stats = compact_save_tool_results_payload(payload)

    content = compacted["tool_results"][0]["content"]
    assert content == serialized.durable_content
    assert decode_multimodal_tool_content(content) is not None
    assert stats.tool_results_compacted == 0


def test_visual_bytes_are_removed_from_observability_copy() -> None:
    serialized = serialize_mcp_tool_result(_screenshot_result(), serialize_tool_result)
    durable_result = {
        "role": "tool",
        "tool_call_id": "shot_1",
        "content": serialized.durable_content,
    }

    redacted = redact_multimodal_tool_result(durable_result)

    assert "SCREENSHOT_BYTES" in json.dumps(durable_result)
    assert "SCREENSHOT_BYTES" not in json.dumps(redacted)
    assert "Screenshot captured" in redacted["content"]
    assert "omitted from telemetry" in redacted["content"]


def test_mcp_error_does_not_forward_visual_content() -> None:
    result = CallToolResult(
        content=[
            TextContent(type="text", text="capture failed"),
            ImageContent(type="image", data="SHOULD_NOT_FORWARD", mimeType="image/png"),
        ],
        isError=True,
    )

    serialized = serialize_mcp_tool_result(result, serialize_tool_result)

    assert serialized.display_text == "Error: capture failed"
    assert serialized.durable_content == "Error: capture failed"
    assert not serialized.is_multimodal


def test_large_screenshot_is_offloaded_before_it_enters_durable_history() -> None:
    # Reproduces the dev failure: 3,099,101 screenshot bytes encode to
    # 4,132,136 base64 characters and push CompleteActivityTask past Dapr's
    # default 4 MiB gRPC body limit.
    screenshot = b"x" * 3_099_101
    encoded = base64.b64encode(screenshot).decode("ascii")
    assert len(encoded) == 4_132_136
    offloader = _RecordingMediaOffloader()

    serialized = serialize_mcp_tool_result(
        _screenshot_result(encoded),
        serialize_tool_result,
        media_offloader=offloader,
    )

    assert offloader.uploads == [(screenshot, "image/png")]
    assert len(serialized.durable_content.encode("utf-8")) < 1024
    assert encoded[:100] not in serialized.durable_content
    parts = decode_multimodal_tool_content(serialized.durable_content)
    assert parts is not None
    assert parts[1] == {
        "type": "image_url",
        "image_url": {"url": "ms://file-1"},
    }

    messages = _normalize_messages_for_kimi(
        None,
        [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "shot_1",
                        "type": "function",
                        "function": {
                            "name": "browser_screenshot",
                            "arguments": "{}",
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "shot_1",
                "content": serialized.durable_content,
            },
        ],
    )
    assert messages[2]["content"][1] == {
        "type": "image_url",
        "image_url": {"url": "ms://file-1"},
    }


def test_local_multimodal_tool_result_uses_same_activity_boundary() -> None:
    offloader = _RecordingMediaOffloader()
    inline = serialize_mcp_tool_result(
        _screenshot_result(base64.b64encode(b"local image").decode("ascii")),
        serialize_tool_result,
    )
    original = {
        "role": "tool",
        "tool_call_id": "read_1",
        "content": inline.durable_content,
    }

    offloaded = offload_multimodal_tool_result(original, offloader)

    assert offloaded is not original
    assert offloader.uploads == [(b"local image", "image/png")]
    assert "ms://file-1" in offloaded["content"]
    assert "bG9jYWwgaW1hZ2U=" not in offloaded["content"]
