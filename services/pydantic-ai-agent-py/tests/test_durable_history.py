"""Reference-backed durable transcript storage contract."""

from __future__ import annotations

import errno
import hashlib
import json
from pathlib import Path

import pytest

from src.adapters.filesystem_durable_history import FilesystemDurableHistoryAdapter
from src.ports.durable_history import (
    DurableHistoryBudgetError,
    DurableHistoryIntegrityError,
    DurableHistoryInvalidReferenceError,
    DurableHistorySerializationError,
)


def _canonical(value: object) -> bytes:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _digest(reference: str) -> str:
    return reference.rsplit("//", 1)[1]


def _adapter(tmp_path, *, max_bytes: int = 64 * 1024 * 1024):
    return FilesystemDurableHistoryAdapter(tmp_path, max_bytes=max_bytes)


def test_history_round_trip_uses_ordered_content_addressed_manifest(tmp_path):
    messages = [
        {
            "kind": "request",
            "parts": [{"content": "hello", "part_kind": "user-prompt"}],
        },
        {"kind": "response", "parts": [{"content": "world", "part_kind": "text"}]},
    ]
    adapter = _adapter(tmp_path)

    reference = adapter.save(messages)

    assert reference.startswith("history+sha256://")
    assert adapter.load(reference) == messages
    manifest_path = (
        tmp_path
        / ".pydantic-ai"
        / "durable-history"
        / "manifests"
        / f"{_digest(reference)}.json"
    )
    manifest_bytes = manifest_path.read_bytes()
    assert hashlib.sha256(manifest_bytes).hexdigest() == _digest(reference)
    manifest = json.loads(manifest_bytes)
    assert manifest["schema"].endswith("/v1")
    assert len(manifest["messageRefs"]) == 2


def test_unchanged_message_blobs_are_deduplicated_and_retries_are_idempotent(tmp_path):
    repeated = {
        "kind": "response",
        "parts": [{"content": "same response", "part_kind": "text"}],
    }
    adapter = _adapter(tmp_path)

    first_reference = adapter.save([repeated, repeated])
    blobs = list(
        (tmp_path / ".pydantic-ai" / "durable-history" / "messages").glob("*.json")
    )
    first_mtime = blobs[0].stat().st_mtime_ns
    second_reference = adapter.save([repeated, repeated])

    assert second_reference == first_reference
    assert len(blobs) == 1
    assert blobs[0].stat().st_mtime_ns == first_mtime


def test_unicode_round_trip_is_canonical_utf8(tmp_path):
    message = {
        "kind": "request",
        "parts": [{"content": "Kimi sees 東京 and 👁️", "part_kind": "user-prompt"}],
    }
    adapter = _adapter(tmp_path)

    reference = adapter.save_message(message)
    blob = (
        tmp_path
        / ".pydantic-ai"
        / "durable-history"
        / "messages"
        / f"{_digest(reference)}.json"
    ).read_bytes()

    assert "東京".encode() in blob
    assert adapter.load_message(reference) == message


@pytest.mark.parametrize("target", ["manifest", "message"])
def test_load_detects_manifest_and_message_tampering(tmp_path, target):
    adapter = _adapter(tmp_path)
    history_ref = adapter.save([{"kind": "response", "parts": []}])
    history_path = (
        tmp_path
        / ".pydantic-ai"
        / "durable-history"
        / "manifests"
        / f"{_digest(history_ref)}.json"
    )
    manifest = json.loads(history_path.read_bytes())
    if target == "manifest":
        history_path.write_bytes(history_path.read_bytes() + b" ")
    else:
        message_ref = manifest["messageRefs"][0]
        message_path = (
            tmp_path
            / ".pydantic-ai"
            / "durable-history"
            / "messages"
            / f"{_digest(message_ref)}.json"
        )
        message_path.write_bytes(message_path.read_bytes() + b" ")

    with pytest.raises(DurableHistoryIntegrityError, match="sha256 mismatch"):
        adapter.load(history_ref)


def test_missing_content_addressed_object_is_terminal_integrity_error(tmp_path):
    adapter = _adapter(tmp_path)
    missing_ref = "history+sha256://" + ("0" * 64)

    with pytest.raises(DurableHistoryIntegrityError, match="unavailable"):
        adapter.load(missing_ref)


def test_filesystem_eio_propagates_for_activity_retry(monkeypatch, tmp_path):
    adapter = _adapter(tmp_path)
    history_ref = adapter.save([{"kind": "response", "parts": []}])

    def fail_read(_path: Path) -> bytes:
        raise OSError(errno.EIO, "transient JuiceFS read failure")

    monkeypatch.setattr(Path, "read_bytes", fail_read)

    with pytest.raises(OSError) as caught:
        adapter.load(history_ref)
    assert caught.value.errno == errno.EIO


@pytest.mark.parametrize(
    "reference",
    [
        "history+sha256://../../secret",
        "history+sha256://" + "A" * 64,
        "history+sha256://" + "0" * 63,
        "history+sha256://" + "0" * 64 + "/extra",
        "history+sha256://" + "0" * 64 + "?path=../secret",
        "message+sha256://" + "0" * 64,
        "/absolute/path",
        "",
    ],
)
def test_history_load_rejects_invalid_or_wrong_kind_references(tmp_path, reference):
    with pytest.raises(DurableHistoryInvalidReferenceError):
        _adapter(tmp_path).load(reference)


def test_full_transcript_budget_is_enforced_exactly(tmp_path):
    messages = [{"kind": "response", "parts": [{"content": "é" * 40}]}]
    exact_size = len(_canonical(messages))

    exact_adapter = _adapter(tmp_path / "exact", max_bytes=exact_size)
    reference = exact_adapter.save(messages)
    assert exact_adapter.load(reference) == messages

    small_adapter = _adapter(tmp_path / "small", max_bytes=exact_size - 1)
    with pytest.raises(DurableHistoryBudgetError) as caught:
        small_adapter.save(messages)
    assert caught.value.actual_bytes == exact_size
    assert caught.value.max_bytes == exact_size - 1


def test_assistant_thinking_and_raw_tool_json_round_trip_unchanged(tmp_path):
    assistant = {
        "finish_reason": "tool_call",
        "kind": "response",
        "model_name": "kimi-k3",
        "parts": [
            {
                "content": "private reasoning with exact whitespace\n  retained",
                "part_kind": "thinking",
            },
            {
                "args": '{"selector":"[data-id=\\"alpha\\"]","count":2}',
                "part_kind": "tool-call",
                "tool_call_id": "call/with:opaque-id",
                "tool_name": "browser_click",
            },
        ],
        "timestamp": "2026-07-22T12:34:56.123456Z",
    }
    tool_return = {
        "kind": "request",
        "parts": [
            {
                "content": {"clicked": True, "nested": [1, {"label": "東京"}]},
                "part_kind": "tool-return",
                "tool_call_id": "call/with:opaque-id",
                "tool_name": "browser_click",
            }
        ],
    }
    messages = [assistant, tool_return]
    adapter = _adapter(tmp_path)

    assistant_ref = adapter.save_message(assistant)
    history_ref = adapter.save(messages)

    assert _canonical(adapter.load_message(assistant_ref)) == _canonical(assistant)
    assert _canonical(adapter.load(history_ref)) == _canonical(messages)
    assert (
        adapter.load(history_ref)[0]["parts"][1]["args"]
        == assistant["parts"][1]["args"]
    )


@pytest.mark.parametrize(
    "messages",
    [
        [{"kind": "response", "parts": [("tuple",)]}],
        [{"kind": "response", "score": float("nan")}],
        [{"kind": "response", 1: "non-string key"}],
    ],
)
def test_save_rejects_values_that_cannot_round_trip_as_json(tmp_path, messages):
    with pytest.raises(DurableHistorySerializationError):
        _adapter(tmp_path).save(messages)
