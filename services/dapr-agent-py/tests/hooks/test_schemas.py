"""Schema parsing: TS-shaped JSON round-trips cleanly into Pydantic models."""
from __future__ import annotations

import json

from src.hooks.schemas import (
    AggregatedHookResult,
    BashCommandHook,
    HookMatcher,
    HooksSettings,
    SyncHookJSONOutput,
)


class TestHookCommandParsing:
    def test_bash_command_minimal(self):
        hook = BashCommandHook(type="command", command="echo hi")
        assert hook.command == "echo hi"
        assert hook.shell is None

    def test_bash_command_ts_aliases(self):
        raw = {
            "type": "command",
            "command": "echo hi",
            "if": "Bash(git *)",
            "statusMessage": "running guard",
            "asyncRewake": True,
            "async": False,
        }
        hook = BashCommandHook.model_validate(raw)
        assert hook.if_ == "Bash(git *)"
        assert hook.status_message == "running guard"
        assert hook.async_rewake is True
        assert hook.async_ is False

    def test_roundtrip_by_alias(self):
        hook = BashCommandHook(type="command", command="x", if_="Read(*.ts)")
        dumped = hook.model_dump(by_alias=True, exclude_none=True)
        assert dumped["if"] == "Read(*.ts)"
        assert "if_" not in dumped


class TestHooksSettings:
    def test_ts_shape_parses(self):
        ts_json = {
            "PreToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [
                        {"type": "command", "command": "echo pre"},
                    ],
                }
            ],
            "PostToolUse": [
                {"hooks": [{"type": "command", "command": "echo post"}]},
            ],
        }
        settings = HooksSettings.from_raw(ts_json)
        assert "PreToolUse" in settings.root
        assert settings.root["PreToolUse"][0].matcher == "Bash"
        assert settings.root["PreToolUse"][0].hooks[0].command == "echo pre"

    def test_invalid_entries_dropped(self):
        settings = HooksSettings.from_raw(
            {
                "PreToolUse": "not a list",
                12345: [{"matcher": "x", "hooks": [{"type": "command", "command": "c"}]}],
            }
        )
        # non-list value dropped
        assert "PreToolUse" not in settings.root
        # non-string key dropped
        assert 12345 not in settings.root

    def test_non_dict_raw_returns_empty(self):
        assert HooksSettings.from_raw("garbage").root == {}
        assert HooksSettings.from_raw(None).root == {}

    def test_roundtrip_to_raw(self):
        raw = {
            "PreToolUse": [
                {"matcher": "Bash", "hooks": [{"type": "command", "command": "x"}]}
            ]
        }
        settings = HooksSettings.from_raw(raw)
        out = settings.to_raw()
        assert "PreToolUse" in out
        assert out["PreToolUse"][0]["matcher"] == "Bash"


class TestHookJSONOutput:
    def test_parses_ts_output(self):
        out = SyncHookJSONOutput.model_validate(
            {
                "continue": False,
                "stopReason": "blocked",
                "decision": "block",
                "reason": "no bash",
                "hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny"},
            }
        )
        assert out.continue_ is False
        assert out.stop_reason == "blocked"
        assert out.decision == "block"
        assert out.hook_specific_output["hookEventName"] == "PreToolUse"


class TestAggregatedHookResult:
    def test_empty_is_non_blocking(self):
        agg = AggregatedHookResult.empty("PreToolUse")
        assert agg.permission_behavior == "allow"
        assert agg.prevent_continuation is False
        assert agg.any_block() is False
