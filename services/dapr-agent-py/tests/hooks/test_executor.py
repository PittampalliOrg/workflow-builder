"""Tests for the executor aggregator."""
from __future__ import annotations

import asyncio
import os

import pytest

from src.hooks.events import HookEvent
from src.hooks.executor import execute_hooks
from src.hooks.registry import HookRegistry
from src.hooks.schemas import BashCommandHook, HookMatcher, HooksSettings


@pytest.fixture(autouse=True)
def _enable_hooks(monkeypatch):
    monkeypatch.setenv("DAPR_AGENT_PY_HOOKS_ENABLED", "true")
    monkeypatch.delenv("DAPR_AGENT_PY_HOOKS_EVENTS", raising=False)


def _mk_settings(event: str, hook_cmd: str, matcher: str = "") -> HooksSettings:
    return HooksSettings.from_raw(
        {
            event: [
                {"matcher": matcher, "hooks": [{"type": "command", "command": hook_cmd}]}
            ]
        }
    )


def test_no_hooks_is_empty():
    reg = HookRegistry()
    snap = reg.snapshot()
    agg = asyncio.run(
        execute_hooks(
            HookEvent.PreToolUse,
            {"tool_name": "Bash", "tool_input": {"command": "ls"}},
            snap,
            match_query="Bash",
        )
    )
    assert agg.any_block() is False
    assert agg.results == []


def test_approve_hook_passes():
    reg = HookRegistry()
    reg.register_from_settings(
        _mk_settings("PreToolUse", "printf '{\"decision\":\"approve\"}'", matcher="Bash"),
        source="user",
    )
    snap = reg.snapshot()
    agg = asyncio.run(
        execute_hooks(
            HookEvent.PreToolUse,
            {"tool_name": "Bash", "tool_input": {"command": "ls"}},
            snap,
            match_query="Bash",
        )
    )
    assert agg.any_block() is False
    assert len(agg.results) == 1


def test_block_hook_blocks():
    reg = HookRegistry()
    reg.register_from_settings(
        _mk_settings(
            "PreToolUse",
            "printf '{\"decision\":\"block\",\"reason\":\"nope\"}'",
            matcher="Bash",
        ),
        source="user",
    )
    snap = reg.snapshot()
    agg = asyncio.run(
        execute_hooks(
            HookEvent.PreToolUse,
            {"tool_name": "Bash", "tool_input": {"command": "ls"}},
            snap,
            match_query="Bash",
        )
    )
    assert agg.any_block() is True
    assert agg.permission_behavior == "deny"
    assert agg.blocking_reason == "nope"


def test_exit_code_2_blocks_even_without_json():
    reg = HookRegistry()
    reg.register_from_settings(
        _mk_settings("PreToolUse", "echo 'forbidden' >&2; exit 2", matcher="Bash"),
        source="user",
    )
    snap = reg.snapshot()
    agg = asyncio.run(
        execute_hooks(
            HookEvent.PreToolUse,
            {"tool_name": "Bash", "tool_input": {"command": "ls"}},
            snap,
            match_query="Bash",
        )
    )
    assert agg.any_block() is True
    assert "forbidden" in (agg.blocking_reason or "")


def test_matcher_filters_hooks():
    reg = HookRegistry()
    reg.register_from_settings(
        _mk_settings(
            "PreToolUse", "printf '{\"decision\":\"block\"}'", matcher="Read"
        ),
        source="user",
    )
    snap = reg.snapshot()
    agg = asyncio.run(
        execute_hooks(
            HookEvent.PreToolUse,
            {"tool_name": "Bash", "tool_input": {"command": "ls"}},
            snap,
            match_query="Bash",
        )
    )
    assert agg.results == []  # matcher "Read" filters out Bash


def test_if_field_filters_hooks():
    reg = HookRegistry()
    reg.register_from_settings(
        HooksSettings.from_raw(
            {
                "PreToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "printf '{\"decision\":\"block\"}'",
                                "if": "Bash(git push*)",
                            }
                        ],
                    }
                ]
            }
        ),
        source="user",
    )
    snap = reg.snapshot()
    # Not a git push -> if filter skips hook
    agg = asyncio.run(
        execute_hooks(
            HookEvent.PreToolUse,
            {"tool_name": "Bash", "tool_input": {"command": "ls"}},
            snap,
            match_query="Bash",
        )
    )
    assert agg.any_block() is False
    # git push -> if filter passes, block fires
    agg = asyncio.run(
        execute_hooks(
            HookEvent.PreToolUse,
            {"tool_name": "Bash", "tool_input": {"command": "git push origin"}},
            snap,
            match_query="Bash",
        )
    )
    assert agg.any_block() is True


def test_updated_input_is_applied():
    reg = HookRegistry()
    reg.register_from_settings(
        _mk_settings(
            "PreToolUse",
            "printf '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"updatedInput\":{\"command\":\"safe-cmd\"}}}'",
            matcher="Bash",
        ),
        source="user",
    )
    snap = reg.snapshot()
    agg = asyncio.run(
        execute_hooks(
            HookEvent.PreToolUse,
            {"tool_name": "Bash", "tool_input": {"command": "rm -rf /"}},
            snap,
            match_query="Bash",
        )
    )
    assert agg.updated_input == {"command": "safe-cmd"}
    assert agg.any_block() is False


def test_flag_off_returns_empty_even_with_hooks(monkeypatch):
    monkeypatch.setenv("DAPR_AGENT_PY_HOOKS_ENABLED", "false")
    reg = HookRegistry()
    reg.register_from_settings(
        _mk_settings("PreToolUse", "exit 2", matcher="Bash"), source="user"
    )
    snap = reg.snapshot()
    agg = asyncio.run(
        execute_hooks(
            HookEvent.PreToolUse,
            {"tool_name": "Bash", "tool_input": {"command": "ls"}},
            snap,
            match_query="Bash",
        )
    )
    assert agg.any_block() is False
    assert agg.results == []
