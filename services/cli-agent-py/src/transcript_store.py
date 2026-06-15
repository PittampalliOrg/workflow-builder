"""Transcript-store durability guard for the interactive-cli runtime family (Phase 2c).

The CLI/JuiceFS family persists its conversation transcript on a per-session
Postgres-backed JuiceFS subtree mounted at ``CLI_TRANSCRIPT_MOUNT`` — set by
sandbox-execution-api ONLY when the execution class declares
``transcriptStoreCsiDriver`` (see ``_cli_transcript_enabled`` in
services/sandbox-execution-api). When the mount is absent the CLI silently falls
back to the pod's ephemeral ``emptyDir``: the transcript dies with the pod and
``claude --continue`` / resume becomes impossible — durability is lost SILENTLY.

This guard FAILS LOUD at startup instead: an interactive-cli pod launched
WITHOUT a transcript store refuses to boot. It can be intentionally opted out
(``CLI_ALLOW_EPHEMERAL_TRANSCRIPT=true``) on dev/test clusters that run without
the JuiceFS CSI driver.

Pure + dependency-free so it unit-tests without dapr/herdr.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Mapping

logger = logging.getLogger(__name__)

TRANSCRIPT_MOUNT_ENV = "CLI_TRANSCRIPT_MOUNT"
ALLOW_EPHEMERAL_ENV = "CLI_ALLOW_EPHEMERAL_TRANSCRIPT"


def _is_truthy(value: str | None) -> bool:
    return bool(value) and value.strip().lower() in ("1", "true", "yes", "on")


def transcript_store_mounted(env: Mapping[str, str]) -> bool:
    """True when ``CLI_TRANSCRIPT_MOUNT`` points at a real directory."""
    raw = (env.get(TRANSCRIPT_MOUNT_ENV) or "").strip()
    if not raw:
        return False
    try:
        return Path(raw).is_dir()
    except OSError:
        return False


def transcript_store_required(env: Mapping[str, str]) -> bool:
    """Durability is required unless explicitly opted out for a non-CSI cluster."""
    return not _is_truthy(env.get(ALLOW_EPHEMERAL_ENV))


def check_transcript_store(env: Mapping[str, str]) -> tuple[bool, str]:
    """Return ``(ok, message)``. ``ok=False`` => required but not mounted."""
    if transcript_store_mounted(env):
        return True, (
            f"{TRANSCRIPT_MOUNT_ENV}={env.get(TRANSCRIPT_MOUNT_ENV)!r} mounted — "
            "durable transcripts (resume/--continue available)"
        )
    if not transcript_store_required(env):
        return True, (
            f"{ALLOW_EPHEMERAL_ENV} set — running with EPHEMERAL transcripts "
            "(no cross-pod resume durability)"
        )
    raw = (env.get(TRANSCRIPT_MOUNT_ENV) or "").strip()
    if not raw:
        return False, (
            f"{TRANSCRIPT_MOUNT_ENV} is not set. This interactive-cli class was launched "
            "without a durable transcript store (the execution class is missing "
            "transcriptStoreCsiDriver). The conversation transcript would live on the pod's "
            "ephemeral emptyDir and be LOST on pod death — resume/--continue would be "
            f"impossible. Configure transcriptStoreCsiDriver on the class, or set "
            f"{ALLOW_EPHEMERAL_ENV}=true to intentionally run without durability."
        )
    return False, (
        f"{TRANSCRIPT_MOUNT_ENV}={raw!r} is not a directory — the JuiceFS CSI mount is "
        "missing or failed to attach. Refusing to run with silently-ephemeral transcripts. "
        f"Fix the CSI mount, or set {ALLOW_EPHEMERAL_ENV}=true to intentionally run without "
        "durability."
    )


def assert_transcript_store(env: Mapping[str, str] | None = None) -> None:
    """Fail loud (``SystemExit(1)``) when durability is required but unavailable.

    Mirrors the ``_assert_subscription_auth_only`` startup-guard pattern in main.py.
    """
    resolved = env if env is not None else os.environ
    ok, message = check_transcript_store(resolved)
    if ok:
        logger.info("[transcript-store] %s", message)
        return
    logger.critical("FATAL: %s", message)
    raise SystemExit(1)


__all__ = [
    "TRANSCRIPT_MOUNT_ENV",
    "ALLOW_EPHEMERAL_ENV",
    "transcript_store_mounted",
    "transcript_store_required",
    "check_transcript_store",
    "assert_transcript_store",
]
