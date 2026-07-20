"""Capability-specific configuration for Kimi provider adapters."""

from __future__ import annotations

import os


DEFAULT_KIMI_CHAT_BASE_URL = "https://api.kimi.com/coding/v1"


def kimi_chat_base_url() -> str:
    """Return the Kimi-for-Coding chat base URL without a trailing slash."""
    configured = os.environ.get("KIMI_BASE_URL", "").strip()
    return (configured or DEFAULT_KIMI_CHAT_BASE_URL).rstrip("/")


def kimi_files_base_url() -> str | None:
    """Return the separately configured Files API base, when available."""
    value = os.environ.get("KIMI_FILES_BASE_URL", "").strip().rstrip("/")
    return value or None


def kimi_formulas_base_url() -> str | None:
    """Return the separately configured Formula API base, when available."""
    value = os.environ.get("KIMI_FORMULAS_BASE_URL", "").strip().rstrip("/")
    return value or None


__all__ = [
    "DEFAULT_KIMI_CHAT_BASE_URL",
    "kimi_chat_base_url",
    "kimi_files_base_url",
    "kimi_formulas_base_url",
]
