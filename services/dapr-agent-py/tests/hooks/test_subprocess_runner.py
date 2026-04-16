"""Tests for the command-hook subprocess runner."""
from __future__ import annotations

import asyncio
import os
import sys

import pytest

from src.hooks.schemas import BashCommandHook
from src.hooks.subprocess_runner import RunnerContext, run_command_hook

pytestmark = pytest.mark.skipif(
    sys.platform == "win32",
    reason="subprocess runner tests target POSIX bash/sh",
)


def _run(coro):
    return asyncio.run(coro)


def test_exit_zero_is_ok():
    hook = BashCommandHook(type="command", command="echo '{}'")
    ctx = RunnerContext(project_dir=os.getcwd())
    result = _run(run_command_hook(hook, {"hook_event_name": "PreToolUse"}, ctx))
    assert result.outcome == "ok"
    assert result.exit_code == 0


def test_exit_two_is_blocking():
    hook = BashCommandHook(
        type="command",
        command="echo 'deny reason' >&2; exit 2",
    )
    ctx = RunnerContext(project_dir=os.getcwd())
    result = _run(run_command_hook(hook, {}, ctx))
    assert result.outcome == "blocking"
    assert result.exit_code == 2
    assert "deny reason" in (result.reason or "")


def test_non_two_nonzero_is_non_blocking():
    hook = BashCommandHook(type="command", command="exit 5")
    ctx = RunnerContext(project_dir=os.getcwd())
    result = _run(run_command_hook(hook, {}, ctx))
    assert result.outcome == "non_blocking_error"
    assert result.exit_code == 5


def test_timeout_is_blocking():
    hook = BashCommandHook(type="command", command="sleep 5", timeout=0.5)
    ctx = RunnerContext(project_dir=os.getcwd())
    result = _run(run_command_hook(hook, {}, ctx))
    assert result.outcome == "blocking"
    assert "timed out" in (result.reason or "")


def test_stdout_json_is_parsed():
    hook = BashCommandHook(
        type="command",
        command='printf \'{"decision":"block","reason":"no"}\'',
    )
    ctx = RunnerContext(project_dir=os.getcwd())
    result = _run(run_command_hook(hook, {}, ctx))
    assert result.outcome == "ok"
    assert result.output is not None
    assert result.output.decision == "block"
    assert result.output.reason == "no"


def test_env_vars_injected():
    hook = BashCommandHook(
        type="command",
        command='printf \'{"reason":"%s|%s"}\' "$CLAUDE_PLUGIN_ROOT" "$CLAUDE_PROJECT_DIR"',
    )
    ctx = RunnerContext(
        project_dir="/tmp/proj",
        plugin_root="/tmp/plug",
    )
    result = _run(run_command_hook(hook, {}, ctx))
    assert result.outcome == "ok"
    assert result.output is not None
    assert "/tmp/plug|/tmp/proj" in (result.output.reason or "")


def test_user_config_substitution():
    hook = BashCommandHook(
        type="command",
        command='printf \'{"reason":"k=${user_config.API_KEY}"}\'',
    )
    ctx = RunnerContext(
        project_dir=os.getcwd(),
        plugin_options={"API_KEY": "sekret"},
    )
    result = _run(run_command_hook(hook, {}, ctx))
    assert result.outcome == "ok"
    assert result.output is not None
    assert "k=sekret" in (result.output.reason or "")


def test_plain_text_stdout_still_ok():
    hook = BashCommandHook(type="command", command="echo just some output")
    ctx = RunnerContext(project_dir=os.getcwd())
    result = _run(run_command_hook(hook, {}, ctx))
    assert result.outcome == "ok"
    assert result.output is None  # plain text => no structured output
