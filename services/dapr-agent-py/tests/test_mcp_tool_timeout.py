"""Tests for the MCP tool-call timeout backstop (src/mcp_tool_timeout.py)."""

from __future__ import annotations

from datetime import timedelta

import pytest

from src.mcp_tool_timeout import (
    _PATCH_FLAG,
    _WRAPPED_ATTR,
    _patch_class,
    resolve_timeout_seconds,
)


class FakeSession:
    """Mirrors mcp ClientSession.__init__'s relevant signature."""

    def __init__(self, read_stream, write_stream, read_timeout_seconds=None, **_kw):
        self.read_stream = read_stream
        self.write_stream = write_stream
        self.read_timeout_seconds = read_timeout_seconds


def _fresh_class():
    # A distinct subclass per test so patches don't leak across tests.
    return type("S", (FakeSession,), {})


# ── resolve_timeout_seconds ─────────────────────────────────────────────────


def test_resolve_default_when_env_unset(monkeypatch):
    monkeypatch.delenv("DAPR_AGENT_MCP_TOOL_TIMEOUT_SECONDS", raising=False)
    assert resolve_timeout_seconds() == 180.0


def test_resolve_override_wins(monkeypatch):
    monkeypatch.setenv("DAPR_AGENT_MCP_TOOL_TIMEOUT_SECONDS", "45")
    assert resolve_timeout_seconds(12.5) == 12.5


def test_resolve_env_value(monkeypatch):
    monkeypatch.setenv("DAPR_AGENT_MCP_TOOL_TIMEOUT_SECONDS", "90")
    assert resolve_timeout_seconds() == 90.0


def test_resolve_invalid_env_falls_back(monkeypatch):
    monkeypatch.setenv("DAPR_AGENT_MCP_TOOL_TIMEOUT_SECONDS", "not-a-number")
    assert resolve_timeout_seconds() == 180.0


def test_resolve_zero_disables(monkeypatch):
    monkeypatch.setenv("DAPR_AGENT_MCP_TOOL_TIMEOUT_SECONDS", "0")
    assert resolve_timeout_seconds() == 0.0


# ── _patch_class injection semantics ────────────────────────────────────────


def test_injects_default_when_omitted():
    cls = _fresh_class()
    assert _patch_class(cls, 180) is True
    s = cls("r", "w")
    assert s.read_timeout_seconds == timedelta(seconds=180)


def test_respects_explicit_keyword():
    cls = _fresh_class()
    _patch_class(cls, 180)
    s = cls("r", "w", read_timeout_seconds=timedelta(seconds=5))
    assert s.read_timeout_seconds == timedelta(seconds=5)


def test_respects_explicit_positional():
    # read_timeout_seconds passed as the 3rd positional arg must be preserved.
    cls = _fresh_class()
    _patch_class(cls, 180)
    s = cls("r", "w", timedelta(seconds=7))
    assert s.read_timeout_seconds == timedelta(seconds=7)


def test_disabled_does_not_inject():
    cls = _fresh_class()
    assert _patch_class(cls, 0) is False
    s = cls("r", "w")
    assert s.read_timeout_seconds is None


def test_idempotent_same_value_does_not_double_wrap():
    cls = _fresh_class()
    _patch_class(cls, 120)
    first = cls.__init__
    _patch_class(cls, 120)
    second = cls.__init__
    assert first is second
    # exactly one wrapper layer
    base = getattr(second, _WRAPPED_ATTR)
    assert not hasattr(base, _WRAPPED_ATTR)
    assert getattr(second, _PATCH_FLAG) == 120


def test_reinstall_different_value_rewraps_without_nesting():
    cls = _fresh_class()
    _patch_class(cls, 60)
    _patch_class(cls, 200)
    s = cls("r", "w")
    assert s.read_timeout_seconds == timedelta(seconds=200)
    # still only one wrapper over the original base
    base = getattr(cls.__init__, _WRAPPED_ATTR)
    assert not hasattr(base, _WRAPPED_ATTR)


def test_disable_after_enable_restores_base():
    cls = _fresh_class()
    original = cls.__init__
    _patch_class(cls, 90)
    assert cls.__init__ is not original
    _patch_class(cls, 0)
    assert cls.__init__ is original
    s = cls("r", "w")
    assert s.read_timeout_seconds is None
