from __future__ import annotations

import json

from src.compaction.payloads import (
    PayloadCompactionConfig,
    TRUNCATION_MARKER_PREFIX,
    build_bounded_summary_task,
    compact_save_tool_results_payload,
)


def test_save_tool_results_payload_compaction_is_deterministic_and_idempotent():
    cfg = PayloadCompactionConfig(
        max_tool_argument_bytes=120,
        max_tool_result_chars=80,
        max_tool_history_argument_chars=24,
        max_summary_tool_history_chars=200,
    )
    payload = {
        "instance_id": "sess-1",
        "tool_results": [
            {
                "role": "tool",
                "name": "Todo",
                "tool_call_id": "call-1",
                "content": "result-" + ("x" * 200),
            }
        ],
        "tool_calls_by_id": {
            "call-1": {
                "tool_call": {
                    "id": "call-1",
                    "function": {
                        "name": "Todo",
                        "arguments": json.dumps({"tasks": ["task-" + ("y" * 80)]}),
                    },
                }
            }
        },
    }

    compacted, stats = compact_save_tool_results_payload(payload, config=cfg)
    compacted_again, stats_again = compact_save_tool_results_payload(compacted, config=cfg)

    assert stats.changed is True
    assert compacted == compacted_again
    assert stats_again.changed is False
    assert compacted["tool_results"][0]["tool_call_id"] == "call-1"
    assert compacted["tool_results"][0]["content"].startswith(TRUNCATION_MARKER_PREFIX)
    raw_args = compacted["tool_calls_by_id"]["call-1"]["tool_call"]["function"]["arguments"]
    assert len(raw_args.encode("utf-8")) <= cfg.max_tool_argument_bytes
    assert raw_args.startswith("{") or raw_args.startswith(TRUNCATION_MARKER_PREFIX)


def test_encrypted_formula_results_skip_clamp_and_marker_is_popped():
    cfg = PayloadCompactionConfig(
        max_tool_argument_bytes=120,
        max_tool_result_chars=80,
        max_tool_history_argument_chars=24,
        max_summary_tool_history_chars=200,
    )
    blob = (
        "----MOONSHOT ENCRYPTED BEGIN----"
        + ("x" * 500)
        + "----MOONSHOT ENCRYPTED END----"
    )
    payload = {
        "instance_id": "sess-1",
        "tool_results": [
            {
                "role": "tool",
                "name": "excel",
                "tool_call_id": "call-1",
                "content": blob,
                "_kimi_encrypted_formula": True,
            },
            {
                "role": "tool",
                "name": "fetch",
                "tool_call_id": "call-2",
                "content": "plain-" + ("y" * 200),
            },
        ],
    }

    compacted, stats = compact_save_tool_results_payload(payload, config=cfg)

    marked, plain = compacted["tool_results"]
    # The encrypted blob survives byte-for-byte (it must round-trip into the
    # next chat request verbatim), and the private marker never reaches
    # persistence.
    assert marked["content"] == blob
    assert "_kimi_encrypted_formula" not in marked
    # Unmarked results keep the standard clamp.
    assert plain["content"].startswith(TRUNCATION_MARKER_PREFIX)
    assert stats.tool_results_compacted == 1


def test_bounded_summary_task_limits_messages_and_tool_history():
    cfg = PayloadCompactionConfig(
        max_tool_argument_bytes=120,
        max_tool_result_chars=80,
        max_tool_history_argument_chars=32,
        max_summary_tool_history_chars=160,
        max_summary_conversation_chars=220,
    )
    task = build_bounded_summary_task(
        [{"role": "user", "content": "u" * 2_000}],
        [{"tool_call_id": "t1", "execution_result": "r" * 2_000}],
        config=cfg,
    )

    assert "Conversation:" in task
    assert "Tool calls/results:" in task
    assert TRUNCATION_MARKER_PREFIX in task
    assert len(task) < 1_000
