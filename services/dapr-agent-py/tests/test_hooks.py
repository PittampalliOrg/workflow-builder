"""End-to-end tests for the hooks system.

Tests the full lifecycle: config loading → registry → matching → execution
→ result aggregation, using real subprocess command hooks.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import textwrap

import pytest

# Import hooks modules directly, avoiding src.tools.__init__ which
# pulls in dapr_agents.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from hooks.types import (
    AggregatedHookResult,
    CallbackHookConfig,
    CommandHookConfig,
    FunctionHookConfig,
    HookBlockingError,
    HookEvent,
    HookInput,
    HookMatcher,
    HookOutcome,
    HookResult,
    HttpHookConfig,
    PostToolUseHookInput,
    PreToolUseHookInput,
    SessionHookMatcher,
    SessionStartHookInput,
)
from hooks.helpers import (
    add_arguments_to_prompt,
    get_hook_display_text,
    hook_input_to_json,
    hook_result_from_output,
    parse_hook_json_output,
)
from hooks.matching import (
    check_if_condition,
    get_match_query,
    get_matching_hooks,
    matches_pattern,
)
from hooks.config import (
    parse_hooks_settings,
    load_hooks_from_file,
)
from hooks.registry import HookRegistry
from hooks.executor import execute_hooks
from hooks.events import (
    HookExecutionEvent,
    emit_hook_started,
    register_hook_event_handler,
)
from hooks.async_registry import AsyncHookRegistry
from hooks.executors.command import exec_command_hook
from hooks.executors.callback import exec_callback_hook, exec_function_hook


# ============================================================================
# HookEvent enum
# ============================================================================


class TestHookEvent:
    def test_all_27_events(self):
        assert len(HookEvent) == 27

    def test_values(self):
        assert HookEvent.PRE_TOOL_USE.value == "PreToolUse"
        assert HookEvent.POST_TOOL_USE.value == "PostToolUse"
        assert HookEvent.SESSION_START.value == "SessionStart"

    def test_from_string(self):
        assert HookEvent("PreToolUse") == HookEvent.PRE_TOOL_USE


# ============================================================================
# Matching
# ============================================================================


class TestMatchesPattern:
    def test_empty_matches_all(self):
        assert matches_pattern("anything", "")

    def test_wildcard_matches_all(self):
        assert matches_pattern("anything", "*")

    def test_exact_match(self):
        assert matches_pattern("Write", "Write")
        assert not matches_pattern("Read", "Write")

    def test_pipe_separated(self):
        assert matches_pattern("Write", "Write|Edit")
        assert matches_pattern("Edit", "Write|Edit")
        assert not matches_pattern("Read", "Write|Edit")

    def test_regex(self):
        assert matches_pattern("WriteFile", "Write.*")
        assert not matches_pattern("ReadFile", "Write.*")

    def test_invalid_regex(self):
        # Should return False, not raise
        assert not matches_pattern("test", "[invalid")


class TestCheckIfCondition:
    def test_empty_always_true(self):
        inp = PreToolUseHookInput(
            hook_event_name=HookEvent.PRE_TOOL_USE, tool_name="Write"
        )
        assert check_if_condition("", inp)

    def test_simple_tool_match(self):
        inp = PreToolUseHookInput(
            hook_event_name=HookEvent.PRE_TOOL_USE, tool_name="Write"
        )
        assert check_if_condition("Write", inp)
        assert not check_if_condition("Read", inp)

    def test_tool_with_arg_pattern(self):
        inp = PreToolUseHookInput(
            hook_event_name=HookEvent.PRE_TOOL_USE,
            tool_name="Bash",
            tool_input={"command": "git status"},
        )
        assert check_if_condition("Bash(git *)", inp)
        assert not check_if_condition("Bash(npm *)", inp)


class TestGetMatchQuery:
    def test_tool_events(self):
        inp = PreToolUseHookInput(
            hook_event_name=HookEvent.PRE_TOOL_USE, tool_name="Write"
        )
        assert get_match_query(HookEvent.PRE_TOOL_USE, inp) == "Write"

    def test_session_start(self):
        inp = SessionStartHookInput(
            hook_event_name=HookEvent.SESSION_START, source="startup"
        )
        assert get_match_query(HookEvent.SESSION_START, inp) == "startup"


class TestGetMatchingHooks:
    def test_finds_matching_hook(self):
        hook = CommandHookConfig(command="echo test")
        matcher = HookMatcher(hooks=[hook], matcher="Write")
        inp = PreToolUseHookInput(
            hook_event_name=HookEvent.PRE_TOOL_USE, tool_name="Write"
        )
        matched = get_matching_hooks(
            HookEvent.PRE_TOOL_USE, inp, [matcher], [], [], match_query="Write"
        )
        assert len(matched) == 1
        assert matched[0][0] is hook

    def test_skips_non_matching(self):
        hook = CommandHookConfig(command="echo test")
        matcher = HookMatcher(hooks=[hook], matcher="Edit")
        inp = PreToolUseHookInput(
            hook_event_name=HookEvent.PRE_TOOL_USE, tool_name="Write"
        )
        matched = get_matching_hooks(
            HookEvent.PRE_TOOL_USE, inp, [matcher], [], [], match_query="Write"
        )
        assert len(matched) == 0

    def test_if_condition_filters(self):
        hook = CommandHookConfig(command="echo test", if_condition="Bash(git *)")
        matcher = HookMatcher(hooks=[hook], matcher="Bash")
        inp = PreToolUseHookInput(
            hook_event_name=HookEvent.PRE_TOOL_USE,
            tool_name="Bash",
            tool_input={"command": "npm install"},
        )
        matched = get_matching_hooks(
            HookEvent.PRE_TOOL_USE, inp, [matcher], [], [], match_query="Bash"
        )
        assert len(matched) == 0  # npm doesn't match git *

    def test_multiple_sources(self):
        h1 = CommandHookConfig(command="settings-hook")
        h2 = CommandHookConfig(command="plugin-hook")
        h3 = CommandHookConfig(command="session-hook")
        inp = PreToolUseHookInput(
            hook_event_name=HookEvent.PRE_TOOL_USE, tool_name="Write"
        )
        matched = get_matching_hooks(
            HookEvent.PRE_TOOL_USE,
            inp,
            [HookMatcher(hooks=[h1], matcher="Write")],
            [HookMatcher(hooks=[h2], matcher="Write")],
            [SessionHookMatcher(hooks=[h3], matcher="Write")],
            match_query="Write",
        )
        assert len(matched) == 3


# ============================================================================
# Helpers
# ============================================================================


class TestHelpers:
    def test_hook_input_to_json(self):
        inp = PreToolUseHookInput(
            hook_event_name=HookEvent.PRE_TOOL_USE,
            session_id="s1",
            tool_name="Write",
            tool_input={"file_path": "/tmp/x"},
        )
        j = json.loads(hook_input_to_json(inp))
        assert j["tool_name"] == "Write"
        assert j["hook_event_name"] == "PreToolUse"
        assert j["session_id"] == "s1"

    def test_add_arguments_to_prompt(self):
        result = add_arguments_to_prompt("Check $ARGUMENTS", '{"x":1}')
        assert result == 'Check {"x":1}'

    def test_parse_hook_json_output_valid(self):
        out = parse_hook_json_output('{"continue": true}')
        assert out == {"continue": True}

    def test_parse_hook_json_output_empty(self):
        assert parse_hook_json_output("") == {}
        assert parse_hook_json_output("not json") == {}

    def test_hook_result_success(self):
        r = hook_result_from_output({"continue": True}, "echo", exit_code=0)
        assert r.outcome == HookOutcome.SUCCESS
        assert not r.prevent_continuation

    def test_hook_result_blocking_exit_code(self):
        r = hook_result_from_output({}, "echo", exit_code=2)
        assert r.outcome == HookOutcome.BLOCKING
        assert r.prevent_continuation

    def test_hook_result_blocking_continue_false(self):
        r = hook_result_from_output(
            {"continue": False, "stopReason": "denied"}, "echo", exit_code=0
        )
        assert r.outcome == HookOutcome.BLOCKING
        assert r.stop_reason == "denied"

    def test_hook_result_permission_decision(self):
        r = hook_result_from_output(
            {"hookSpecificOutput": {"permissionDecision": "approve", "additionalContext": "ok"}},
            "echo",
            exit_code=0,
        )
        assert r.permission_behavior == "allow"
        assert r.additional_context == "ok"

    def test_hook_result_updated_input(self):
        r = hook_result_from_output(
            {"hookSpecificOutput": {"updatedInput": {"file_path": "/new"}}},
            "echo",
            exit_code=0,
        )
        assert r.updated_input == {"file_path": "/new"}

    def test_get_hook_display_text(self):
        assert "command:" in get_hook_display_text(CommandHookConfig(command="ls"))
        assert "http:" in get_hook_display_text(HttpHookConfig(url="http://x"))


# ============================================================================
# Config loading
# ============================================================================


class TestConfigParsing:
    def test_parse_hooks_settings(self):
        raw = {
            "PreToolUse": [
                {
                    "matcher": "Write",
                    "hooks": [
                        {"type": "command", "command": "validate.sh", "timeout": 5}
                    ],
                }
            ],
            "SessionStart": [
                {
                    "matcher": "startup",
                    "hooks": [
                        {"type": "command", "command": "setup.sh", "async": True}
                    ],
                }
            ],
        }
        parsed = parse_hooks_settings(raw)
        assert HookEvent.PRE_TOOL_USE in parsed
        assert HookEvent.SESSION_START in parsed
        assert parsed[HookEvent.PRE_TOOL_USE][0].matcher == "Write"
        hook = parsed[HookEvent.PRE_TOOL_USE][0].hooks[0]
        assert isinstance(hook, CommandHookConfig)
        assert hook.command == "validate.sh"
        assert hook.timeout == 5

    def test_parse_all_hook_types(self):
        raw = {
            "PreToolUse": [
                {
                    "matcher": "*",
                    "hooks": [
                        {"type": "command", "command": "cmd"},
                        {"type": "prompt", "prompt": "check $ARGUMENTS"},
                        {"type": "agent", "prompt": "verify"},
                        {"type": "http", "url": "http://localhost:8080/hook"},
                    ],
                }
            ]
        }
        parsed = parse_hooks_settings(raw)
        hooks = parsed[HookEvent.PRE_TOOL_USE][0].hooks
        assert len(hooks) == 4
        assert hooks[0].type == "command"
        assert hooks[1].type == "prompt"
        assert hooks[2].type == "agent"
        assert hooks[3].type == "http"

    def test_unknown_event_skipped(self):
        raw = {"UnknownEvent": [{"matcher": "", "hooks": []}]}
        parsed = parse_hooks_settings(raw)
        assert len(parsed) == 0

    def test_load_from_file(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(
                {
                    "hooks": {
                        "PreToolUse": [
                            {
                                "matcher": "Bash",
                                "hooks": [
                                    {"type": "command", "command": "lint.sh"}
                                ],
                            }
                        ]
                    }
                },
                f,
            )
            f.flush()
            parsed = load_hooks_from_file(f.name)
        os.unlink(f.name)
        assert HookEvent.PRE_TOOL_USE in parsed

    def test_load_missing_file(self):
        parsed = load_hooks_from_file("/nonexistent/path.json")
        assert parsed == {}


# ============================================================================
# Registry
# ============================================================================


class TestHookRegistry:
    def test_load_and_query(self):
        reg = HookRegistry()
        raw = {
            "PreToolUse": [
                {"matcher": "Write", "hooks": [{"type": "command", "command": "echo"}]}
            ]
        }
        reg.load_from_settings(raw)
        assert reg.has_hooks_for_event("", HookEvent.PRE_TOOL_USE)
        assert not reg.has_hooks_for_event("", HookEvent.SESSION_END)

    def test_session_hooks(self):
        reg = HookRegistry()
        hook = CommandHookConfig(command="echo session")
        reg.add_session_hook("s1", HookEvent.PRE_TOOL_USE, "Write", hook)
        assert reg.has_hooks_for_event("s1", HookEvent.PRE_TOOL_USE)
        assert not reg.has_hooks_for_event("s2", HookEvent.PRE_TOOL_USE)

        reg.clear_session_hooks("s1")
        assert not reg.has_hooks_for_event("s1", HookEvent.PRE_TOOL_USE)

    def test_function_hook(self):
        reg = HookRegistry()
        hook_id = reg.add_function_hook(
            "s1",
            HookEvent.PRE_TOOL_USE,
            "Write",
            callback=lambda msgs: True,
            error_message="fail",
        )
        assert reg.has_hooks_for_event("s1", HookEvent.PRE_TOOL_USE)

        reg.remove_function_hook("s1", HookEvent.PRE_TOOL_USE, hook_id)
        assert not reg.has_hooks_for_event("s1", HookEvent.PRE_TOOL_USE)

    def test_registered_hooks(self):
        reg = HookRegistry()
        hook = CommandHookConfig(command="plugin-hook")
        matcher = HookMatcher(hooks=[hook], matcher="*", plugin_id="test@builtin")
        reg.register_hooks(HookEvent.POST_TOOL_USE, [matcher])
        assert reg.has_hooks_for_event("", HookEvent.POST_TOOL_USE)

        reg.clear_registered_hooks()
        assert not reg.has_hooks_for_event("", HookEvent.POST_TOOL_USE)

    def test_get_all_for_event(self):
        reg = HookRegistry()
        reg.load_from_settings(
            {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "a"}]}]}
        )
        reg.register_hooks(
            HookEvent.PRE_TOOL_USE,
            [HookMatcher(hooks=[CommandHookConfig(command="b")])],
        )
        reg.add_session_hook("s1", HookEvent.PRE_TOOL_USE, "*", CommandHookConfig(command="c"))

        settings, registered, session = reg.get_all_for_event("s1", HookEvent.PRE_TOOL_USE)
        assert len(settings) == 1
        assert len(registered) == 1
        assert len(session) == 1


# ============================================================================
# Command executor (real subprocess)
# ============================================================================


class TestCommandExecutor:
    def test_success_json_output(self):
        hook = CommandHookConfig(command='echo \'{"continue": true}\'')
        result = exec_command_hook(hook, '{}', timeout=5)
        assert result.outcome == HookOutcome.SUCCESS

    def test_blocking_exit_code_2(self):
        hook = CommandHookConfig(command="exit 2")
        result = exec_command_hook(hook, '{}', timeout=5)
        assert result.outcome == HookOutcome.BLOCKING
        assert result.prevent_continuation

    def test_non_blocking_error(self):
        hook = CommandHookConfig(command="exit 1")
        result = exec_command_hook(hook, '{}', timeout=5)
        assert result.outcome == HookOutcome.NON_BLOCKING_ERROR

    def test_reads_stdin(self):
        """Hook receives JSON on stdin and can use it."""
        # jq extracts tool_name from stdin JSON, echoes it back
        hook = CommandHookConfig(
            command="python3 -c \"import sys,json; d=json.load(sys.stdin); print(json.dumps({'continue':True,'hookSpecificOutput':{'additionalContext':d.get('tool_name','?')}}))\""
        )
        inp = json.dumps({"tool_name": "Write", "hook_event_name": "PreToolUse"})
        result = exec_command_hook(hook, inp, timeout=5)
        assert result.outcome == HookOutcome.SUCCESS
        assert result.additional_context == "Write"

    def test_blocking_via_continue_false(self):
        hook = CommandHookConfig(
            command='echo \'{"continue": false, "stopReason": "not allowed"}\''
        )
        result = exec_command_hook(hook, '{}', timeout=5)
        assert result.outcome == HookOutcome.BLOCKING
        assert result.stop_reason == "not allowed"

    def test_timeout(self):
        hook = CommandHookConfig(command="sleep 10")
        result = exec_command_hook(hook, '{}', timeout=1)
        assert result.outcome == HookOutcome.NON_BLOCKING_ERROR

    def test_env_override(self):
        hook = CommandHookConfig(command='echo "{}"')
        result = exec_command_hook(
            hook, '{}', env_overrides={"CLAUDE_PLUGIN_ROOT": "/opt/test"}, timeout=5
        )
        assert result.outcome == HookOutcome.SUCCESS

    def test_updated_input(self):
        hook = CommandHookConfig(
            command='echo \'{"continue":true,"hookSpecificOutput":{"updatedInput":{"file_path":"/new/path"}}}\''
        )
        result = exec_command_hook(hook, '{}', timeout=5)
        assert result.outcome == HookOutcome.SUCCESS
        assert result.updated_input == {"file_path": "/new/path"}

    def test_permission_decision(self):
        hook = CommandHookConfig(
            command='echo \'{"continue":true,"hookSpecificOutput":{"permissionDecision":"block","permissionDecisionReason":"unsafe"}}\''
        )
        result = exec_command_hook(hook, '{}', timeout=5)
        assert result.permission_behavior == "deny"
        assert result.permission_decision_reason == "unsafe"


# ============================================================================
# Callback executor
# ============================================================================


class TestCallbackExecutor:
    def test_success(self):
        hook = CallbackHookConfig(callback=lambda inp, tid: {"continue": True})
        result = exec_callback_hook(hook, {})
        assert result.outcome == HookOutcome.SUCCESS

    def test_exception(self):
        def bad_cb(inp, tid):
            raise ValueError("boom")

        hook = CallbackHookConfig(callback=bad_cb)
        result = exec_callback_hook(hook, {})
        assert result.outcome == HookOutcome.NON_BLOCKING_ERROR


class TestFunctionHookExecutor:
    def test_passes(self):
        hook = FunctionHookConfig(callback=lambda msgs: True, error_message="fail")
        result = exec_function_hook(hook)
        assert result.outcome == HookOutcome.SUCCESS

    def test_blocks(self):
        hook = FunctionHookConfig(callback=lambda msgs: False, error_message="denied")
        result = exec_function_hook(hook)
        assert result.outcome == HookOutcome.BLOCKING
        assert result.blocking_error is not None
        assert result.blocking_error.blocking_error == "denied"


# ============================================================================
# Core executor (end-to-end)
# ============================================================================


class TestExecuteHooks:
    def test_no_hooks_registered(self):
        reg = HookRegistry()
        # Use a fresh registry (not the singleton)
        from hooks import executor as _executor

        old = _executor.get_hook_registry
        _executor.get_hook_registry = lambda: reg
        try:
            result = execute_hooks(
                HookEvent.PRE_TOOL_USE,
                PreToolUseHookInput(
                    hook_event_name=HookEvent.PRE_TOOL_USE,
                    tool_name="Write",
                ),
            )
            assert not result.has_blocking_errors
            assert not result.prevent_continuation
        finally:
            _executor.get_hook_registry = old

    def test_single_command_hook_success(self):
        reg = HookRegistry()
        reg.load_from_settings(
            {
                "PreToolUse": [
                    {
                        "matcher": "Write",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "echo '{\"continue\": true}'",
                                "timeout": 5,
                            }
                        ],
                    }
                ]
            }
        )
        from hooks import executor as _executor

        old = _executor.get_hook_registry
        _executor.get_hook_registry = lambda: reg
        try:
            result = execute_hooks(
                HookEvent.PRE_TOOL_USE,
                PreToolUseHookInput(
                    hook_event_name=HookEvent.PRE_TOOL_USE,
                    tool_name="Write",
                    tool_input={"file_path": "/test"},
                ),
                match_query="Write",
            )
            assert not result.has_blocking_errors
        finally:
            _executor.get_hook_registry = old

    def test_blocking_hook(self):
        reg = HookRegistry()
        reg.load_from_settings(
            {
                "PreToolUse": [
                    {
                        "matcher": "Write",
                        "hooks": [
                            {"type": "command", "command": "exit 2", "timeout": 5}
                        ],
                    }
                ]
            }
        )
        from hooks import executor as _executor

        old = _executor.get_hook_registry
        _executor.get_hook_registry = lambda: reg
        try:
            result = execute_hooks(
                HookEvent.PRE_TOOL_USE,
                PreToolUseHookInput(
                    hook_event_name=HookEvent.PRE_TOOL_USE,
                    tool_name="Write",
                ),
                match_query="Write",
            )
            assert result.has_blocking_errors
            assert result.prevent_continuation
        finally:
            _executor.get_hook_registry = old

    def test_parallel_hooks(self):
        """Multiple hooks execute in parallel and results are aggregated."""
        reg = HookRegistry()
        reg.load_from_settings(
            {
                "PreToolUse": [
                    {
                        "matcher": "*",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "echo '{\"continue\":true,\"hookSpecificOutput\":{\"additionalContext\":\"hook1\"}}'",
                                "timeout": 5,
                            },
                            {
                                "type": "command",
                                "command": "echo '{\"continue\":true,\"hookSpecificOutput\":{\"additionalContext\":\"hook2\"}}'",
                                "timeout": 5,
                            },
                        ],
                    }
                ]
            }
        )
        from hooks import executor as _executor

        old = _executor.get_hook_registry
        _executor.get_hook_registry = lambda: reg
        try:
            result = execute_hooks(
                HookEvent.PRE_TOOL_USE,
                PreToolUseHookInput(
                    hook_event_name=HookEvent.PRE_TOOL_USE,
                    tool_name="Write",
                ),
                match_query="Write",
            )
            assert not result.has_blocking_errors
            assert len(result.additional_contexts) == 2
            assert set(result.additional_contexts) == {"hook1", "hook2"}
        finally:
            _executor.get_hook_registry = old

    def test_permission_deny_wins(self):
        """deny beats allow in permission precedence."""
        reg = HookRegistry()
        reg.load_from_settings(
            {
                "PreToolUse": [
                    {
                        "matcher": "*",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "echo '{\"continue\":true,\"hookSpecificOutput\":{\"permissionDecision\":\"approve\"}}'",
                                "timeout": 5,
                            },
                            {
                                "type": "command",
                                "command": "echo '{\"continue\":true,\"hookSpecificOutput\":{\"permissionDecision\":\"block\"}}'",
                                "timeout": 5,
                            },
                        ],
                    }
                ]
            }
        )
        from hooks import executor as _executor

        old = _executor.get_hook_registry
        _executor.get_hook_registry = lambda: reg
        try:
            result = execute_hooks(
                HookEvent.PRE_TOOL_USE,
                PreToolUseHookInput(
                    hook_event_name=HookEvent.PRE_TOOL_USE,
                    tool_name="Write",
                ),
                match_query="Write",
            )
            assert result.permission_behavior == "deny"
        finally:
            _executor.get_hook_registry = old

    def test_updated_input_passthrough(self):
        """Hook can modify tool input."""
        reg = HookRegistry()
        reg.load_from_settings(
            {
                "PreToolUse": [
                    {
                        "matcher": "Write",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "echo '{\"continue\":true,\"hookSpecificOutput\":{\"updatedInput\":{\"file_path\":\"/modified\"}}}'",
                                "timeout": 5,
                            }
                        ],
                    }
                ]
            }
        )
        from hooks import executor as _executor

        old = _executor.get_hook_registry
        _executor.get_hook_registry = lambda: reg
        try:
            result = execute_hooks(
                HookEvent.PRE_TOOL_USE,
                PreToolUseHookInput(
                    hook_event_name=HookEvent.PRE_TOOL_USE,
                    tool_name="Write",
                    tool_input={"file_path": "/original"},
                ),
                match_query="Write",
            )
            assert result.updated_input == {"file_path": "/modified"}
        finally:
            _executor.get_hook_registry = old

    def test_hook_reads_input_from_stdin(self):
        """End-to-end: hook receives tool_name via stdin JSON and reflects it back."""
        reg = HookRegistry()
        reg.load_from_settings(
            {
                "PreToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "python3 -c \"import sys,json; d=json.load(sys.stdin); print(json.dumps({'continue':True,'hookSpecificOutput':{'additionalContext':d['tool_name']}}))\"",
                                "timeout": 5,
                            }
                        ],
                    }
                ]
            }
        )
        from hooks import executor as _executor

        old = _executor.get_hook_registry
        _executor.get_hook_registry = lambda: reg
        try:
            result = execute_hooks(
                HookEvent.PRE_TOOL_USE,
                PreToolUseHookInput(
                    hook_event_name=HookEvent.PRE_TOOL_USE,
                    tool_name="Bash",
                    tool_input={"command": "git status"},
                ),
                match_query="Bash",
            )
            assert not result.has_blocking_errors
            assert "Bash" in result.additional_contexts
        finally:
            _executor.get_hook_registry = old


# ============================================================================
# Full settings file → execution E2E
# ============================================================================


class TestEndToEndSettingsFile:
    def test_load_file_execute_hooks(self):
        """Load hooks from a real settings.json file, then execute them."""
        settings = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Write",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "echo '{\"continue\":true,\"hookSpecificOutput\":{\"additionalContext\":\"validated\"}}'",
                                "timeout": 5,
                            }
                        ],
                    },
                    {
                        "matcher": "Bash",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "exit 2",
                                "timeout": 5,
                            }
                        ],
                    },
                ],
                "PostToolUse": [
                    {
                        "matcher": "*",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "echo '{\"continue\":true}'",
                                "timeout": 5,
                            }
                        ],
                    },
                ],
            }
        }

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(settings, f)
            f.flush()
            config_path = f.name

        try:
            parsed = load_hooks_from_file(config_path)
            reg = HookRegistry()
            # Manually load (normally load_from_settings takes raw dict)
            for event, matchers in parsed.items():
                for m in matchers:
                    reg.register_hooks(event, [m])

            from hooks import executor as _executor

            old = _executor.get_hook_registry
            _executor.get_hook_registry = lambda: reg

            # Write tool: should succeed with additionalContext
            result = execute_hooks(
                HookEvent.PRE_TOOL_USE,
                PreToolUseHookInput(
                    hook_event_name=HookEvent.PRE_TOOL_USE,
                    tool_name="Write",
                ),
                match_query="Write",
            )
            assert not result.has_blocking_errors
            assert "validated" in result.additional_contexts

            # Bash tool: should be blocked (exit 2)
            result = execute_hooks(
                HookEvent.PRE_TOOL_USE,
                PreToolUseHookInput(
                    hook_event_name=HookEvent.PRE_TOOL_USE,
                    tool_name="Bash",
                    tool_input={"command": "rm -rf /"},
                ),
                match_query="Bash",
            )
            assert result.has_blocking_errors
            assert result.prevent_continuation

            # PostToolUse for any tool: should succeed
            result = execute_hooks(
                HookEvent.POST_TOOL_USE,
                PostToolUseHookInput(
                    hook_event_name=HookEvent.POST_TOOL_USE,
                    tool_name="Read",
                    tool_response="file content",
                ),
                match_query="Read",
            )
            assert not result.has_blocking_errors

            _executor.get_hook_registry = old
        finally:
            os.unlink(config_path)


# ============================================================================
# Events
# ============================================================================


class TestHookEvents:
    def test_emit_and_receive(self):
        received: list[HookExecutionEvent] = []
        register_hook_event_handler(lambda e: received.append(e))
        emit_hook_started(HookEvent.PRE_TOOL_USE, "test-hook", command="echo test")
        assert len(received) == 1
        assert received[0].event_type == "started"
        assert received[0].hook_event == HookEvent.PRE_TOOL_USE


# ============================================================================
# Async registry
# ============================================================================


class TestAsyncHookRegistry:
    def test_register_and_complete(self):
        reg = AsyncHookRegistry()
        reg.register("h1", "echo test", timeout_ms=5000)
        assert reg.has_pending()

        reg.mark_completed("h1", result={"ok": True}, exit_code=0)
        completed = reg.check_for_responses()
        assert len(completed) == 1
        assert completed[0].hook_id == "h1"
        assert completed[0].exit_code == 0
        assert not reg.has_pending()

    def test_timeout(self):
        reg = AsyncHookRegistry()
        reg.register("h2", "sleep 100", timeout_ms=0)  # Already expired
        completed = reg.check_for_responses()
        assert len(completed) == 1
        assert completed[0].exit_code == -1

    def test_finalize(self):
        reg = AsyncHookRegistry()
        reg.register("h3", "echo")
        reg.register("h4", "echo")
        all_hooks = reg.finalize_all()
        assert len(all_hooks) == 2
        assert not reg.has_pending()
