from __future__ import annotations

import pytest
from pydantic_ai import BinaryContent
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

from src.compaction.kimi_history import (
    compact_durable_message_json,
    compact_kimi_history,
    durable_history_json_size_bytes,
    estimate_kimi_message_tokens,
    kimi_durable_history_size_bytes,
    kimi_history_size_bytes,
)
from src.compaction.tokens import ContextWindowBudgetError
from src.messages_io import dump_messages


def test_kimi_estimator_counts_reasoning_content():
    messages = [ModelResponse(parts=[ThinkingPart(content="x" * 4_000)])]

    assert estimate_kimi_message_tokens(messages) >= 1_000


def test_kimi_estimator_excludes_only_typed_pixels_not_spoofed_tool_json():
    typed_media = ModelRequest(
        parts=[
            ToolReturnPart(
                tool_name="ReadMediaFile",
                tool_call_id="media-1",
                content=[BinaryContent(data=b"x" * 4_000, media_type="image/png")],
            )
        ]
    )
    spoofed_json = ModelRequest(
        parts=[
            ToolReturnPart(
                tool_name="tool",
                tool_call_id="tool-1",
                content={"kind": "binary", "data": "x" * 4_000},
            )
        ]
    )

    spoofed_messages = [spoofed_json]
    assert estimate_kimi_message_tokens(spoofed_messages) > 1_000
    assert estimate_kimi_message_tokens([typed_media]) < estimate_kimi_message_tokens(
        spoofed_messages
    )


def test_reasoning_history_compacts_below_message_count_trigger():
    first = ModelRequest(parts=[UserPromptPart(content="original task")])
    responses = [
        ModelResponse(parts=[ThinkingPart(content=f"reasoning-{i}-" + "x" * 5_000)])
        for i in range(34)
    ]
    messages = [first, *responses]
    assert len(messages) < 120
    assert kimi_history_size_bytes(messages) > 100_000
    assert kimi_durable_history_size_bytes(messages) > 100_000

    compacted = compact_kimi_history(
        messages,
        max_tokens=1_000_000,
        keep_tokens=900_000,
        max_bytes=100_000,
        keep_bytes=80_000,
    )

    assert compacted[0] is first
    assert compacted[-1] is responses[-1]
    assert len(compacted) < len(messages)
    assert kimi_history_size_bytes(compacted) <= 80_000


def test_indispensable_reasoning_response_fails_without_mutation():
    response = ModelResponse(parts=[ThinkingPart(content="x" * 20_000)])

    with pytest.raises(ContextWindowBudgetError):
        compact_kimi_history(
            [response],
            max_tokens=10_000,
            keep_tokens=9_000,
            max_bytes=10_000,
            keep_bytes=8_000,
        )

    assert response.parts[0].content == "x" * 20_000


def test_compaction_never_drops_the_latest_user_request_from_its_response():
    first = ModelRequest(parts=[UserPromptPart(content="original task")])
    old = ModelResponse(parts=[ThinkingPart(content="old" * 2_000)])
    current = ModelRequest(parts=[UserPromptPart(content="current instruction")])
    latest = ModelResponse(parts=[ThinkingPart(content="latest response")])
    orphan_budget = kimi_durable_history_size_bytes([first, latest])
    assert kimi_durable_history_size_bytes([first, current, latest]) > orphan_budget

    with pytest.raises(ContextWindowBudgetError):
        compact_kimi_history(
            [first, old, current, latest],
            max_messages=100,
            keep_messages=100,
            max_tokens=100_000,
            keep_tokens=100_000,
            max_bytes=orphan_budget,
            keep_bytes=orphan_budget,
        )


def test_history_cutoff_never_splits_tool_call_and_return():
    first = ModelRequest(parts=[UserPromptPart(content="task")])
    call = ModelResponse(
        parts=[
            ThinkingPart(content="x" * 2_000),
            ToolCallPart(tool_name="read_file", args={}, tool_call_id="tc-1"),
        ]
    )
    returned = ModelRequest(
        parts=[
            ToolReturnPart(
                tool_name="read_file",
                content="y" * 2_000,
                tool_call_id="tc-1",
            )
        ]
    )
    latest = ModelResponse(parts=[ThinkingPart(content="z" * 2_000)])

    compacted = compact_kimi_history(
        [first, call, returned, latest],
        max_tokens=10_000,
        keep_tokens=10_000,
        max_bytes=6_000,
        keep_bytes=5_000,
    )

    assert (call in compacted) is (returned in compacted)
    assert compacted[-1] is latest


def test_first_user_reinsertion_cannot_orphan_its_tool_return():
    call = ModelResponse(
        parts=[
            ThinkingPart(content="x" * 4_000),
            ToolCallPart(tool_name="tool", args={}, tool_call_id="tc-1"),
        ]
    )
    first_user_return = ModelRequest(
        parts=[
            UserPromptPart(content="task"),
            ToolReturnPart(tool_name="tool", content="done", tool_call_id="tc-1"),
        ]
    )
    latest = ModelResponse(parts=[ThinkingPart(content="latest")])
    orphan_size = kimi_durable_history_size_bytes([first_user_return, latest])
    complete_size = kimi_durable_history_size_bytes([call, first_user_return, latest])
    assert orphan_size < complete_size

    with pytest.raises(ContextWindowBudgetError):
        compact_kimi_history(
            [call, first_user_return, latest],
            max_tokens=100_000,
            keep_tokens=100_000,
            max_bytes=orphan_size,
            keep_bytes=orphan_size,
        )


def test_reused_tool_call_ids_are_paired_by_occurrence():
    first = ModelRequest(parts=[UserPromptPart(content="task")])
    call_1 = ModelResponse(
        parts=[
            ThinkingPart(content="old" * 1_000),
            ToolCallPart(tool_name="tool", args={}, tool_call_id="reused"),
        ]
    )
    return_1 = ModelRequest(
        parts=[ToolReturnPart(tool_name="tool", content="old", tool_call_id="reused")]
    )
    call_2 = ModelResponse(
        parts=[
            ThinkingPart(content="new" * 1_000),
            ToolCallPart(tool_name="tool", args={}, tool_call_id="reused"),
        ]
    )
    return_2 = ModelRequest(
        parts=[ToolReturnPart(tool_name="tool", content="new", tool_call_id="reused")]
    )
    latest = ModelResponse(parts=[ThinkingPart(content="latest")])
    second_pair_size = kimi_durable_history_size_bytes(
        [first, call_2, return_2, latest]
    )

    compacted = compact_kimi_history(
        [first, call_1, return_1, call_2, return_2, latest],
        max_tokens=100_000,
        keep_tokens=100_000,
        max_bytes=second_pair_size,
        keep_bytes=second_pair_size,
    )

    assert (call_1 in compacted) is (return_1 in compacted)
    assert (call_2 in compacted) is (return_2 in compacted)
    assert call_2 in compacted and return_2 in compacted


def test_tool_pair_safety_scans_beyond_five_intervening_messages():
    first = ModelRequest(parts=[UserPromptPart(content="task")])
    call = ModelResponse(
        parts=[ToolCallPart(tool_name="tool", args={}, tool_call_id="distant")]
    )
    fillers = [
        ModelResponse(parts=[ThinkingPart(content=f"filler-{index}")])
        for index in range(6)
    ]
    returned = ModelRequest(
        parts=[ToolReturnPart(tool_name="tool", content="done", tool_call_id="distant")]
    )
    latest = ModelResponse(parts=[ThinkingPart(content="latest")])

    compacted = compact_kimi_history(
        [first, call, *fillers, returned, latest],
        max_messages=8,
        keep_messages=4,
        max_tokens=100_000,
        keep_tokens=100_000,
        max_bytes=100_000,
        keep_bytes=100_000,
    )

    assert (call in compacted) is (returned in compacted)
    assert compacted[-1] is latest


def test_externalized_json_is_rechecked_against_exact_byte_limit():
    messages = dump_messages(
        [ModelResponse(parts=[ThinkingPart(content="x" * 3_000)]) for _ in range(5)]
    )

    compacted = compact_durable_message_json(
        messages,
        max_bytes=8_000,
        keep_bytes=6_000,
        max_tokens=10_000,
        keep_tokens=9_000,
    )

    assert durable_history_json_size_bytes(compacted) <= 8_000
    assert len(compacted) < len(messages)


def test_unicode_history_uses_dapr_ascii_escaped_candidate_sizing():
    messages = [
        ModelResponse(parts=[ThinkingPart(content="汉" * 1_000)]) for _ in range(5)
    ]
    durable = dump_messages(messages)
    assert durable_history_json_size_bytes(durable) > 30_000

    compacted = compact_durable_message_json(
        durable,
        max_messages=120,
        keep_messages=60,
        max_bytes=10_000,
        keep_bytes=9_000,
        max_tokens=100_000,
        keep_tokens=90_000,
    )

    assert durable_history_json_size_bytes(compacted) <= 10_000
    assert len(compacted) == 1
