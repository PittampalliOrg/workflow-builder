"""Tests for the Phase 2c transcript-store durability startup guard.

Proves an interactive-cli pod launched WITHOUT a durable transcript store
(no CLI_TRANSCRIPT_MOUNT, i.e. the class lacked transcriptStoreCsiDriver) fails
loud (SystemExit), while a mounted store or an explicit opt-out boots cleanly.
"""
from __future__ import annotations

import pytest

from src.transcript_store import (
    ALLOW_EPHEMERAL_ENV,
    TRANSCRIPT_MOUNT_ENV,
    assert_transcript_store,
    check_transcript_store,
    transcript_store_mounted,
    transcript_store_required,
)


def test_mount_detected_when_dir_exists(tmp_path):
    env = {TRANSCRIPT_MOUNT_ENV: str(tmp_path)}
    assert transcript_store_mounted(env) is True
    assert check_transcript_store(env)[0] is True


def test_mount_absent_when_unset_or_missing(tmp_path):
    assert transcript_store_mounted({}) is False
    assert transcript_store_mounted({TRANSCRIPT_MOUNT_ENV: ""}) is False
    assert (
        transcript_store_mounted({TRANSCRIPT_MOUNT_ENV: str(tmp_path / "nope")}) is False
    )


def test_required_by_default_optout_via_env():
    assert transcript_store_required({}) is True
    assert transcript_store_required({ALLOW_EPHEMERAL_ENV: "true"}) is False
    assert transcript_store_required({ALLOW_EPHEMERAL_ENV: "1"}) is False


def test_assert_fails_loud_without_mount():
    # No mount, no opt-out -> required but unavailable -> SystemExit(1).
    with pytest.raises(SystemExit) as exc:
        assert_transcript_store({})
    assert exc.value.code == 1


def test_assert_fails_loud_when_mount_not_a_directory(tmp_path):
    missing = tmp_path / "not-a-dir"
    with pytest.raises(SystemExit) as exc:
        assert_transcript_store({TRANSCRIPT_MOUNT_ENV: str(missing)})
    assert exc.value.code == 1


def test_assert_passes_with_mounted_store(tmp_path):
    # Mounted directory -> boots cleanly (no SystemExit).
    assert_transcript_store({TRANSCRIPT_MOUNT_ENV: str(tmp_path)})


def test_assert_passes_with_explicit_optout():
    # Intentional non-CSI dev cluster -> boots with ephemeral transcripts.
    assert_transcript_store({ALLOW_EPHEMERAL_ENV: "true"})


def test_check_message_explains_missing_csi():
    ok, message = check_transcript_store({})
    assert ok is False
    assert "transcriptStoreCsiDriver" in message
    assert TRANSCRIPT_MOUNT_ENV in message
