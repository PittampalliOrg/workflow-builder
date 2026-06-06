from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from src.claude_sdk_runner import (
    build_claude_options,
    capture_git_model_patch,
    normalize_claude_model,
    normalize_permission_mode,
    resolve_cwd,
    swebench_environment,
    system_prompt_config,
)


def test_normalizes_workflow_builder_model_specs() -> None:
    assert normalize_claude_model("anthropic/claude-opus-4-8") == "claude-opus-4-8"
    assert normalize_claude_model("anthropic/claude-opus-4-7") == "claude-opus-4-7"
    assert normalize_claude_model("claude-sonnet-4-6") == "claude-sonnet-4-6"
    assert normalize_claude_model("nvidia/qwen") == "claude-opus-4-8"


def test_builds_claude_code_presets_with_appended_system_prompt(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("src.claude_sdk_runner.DEFAULT_CWD", str(tmp_path))
    options = build_claude_options(
        {
            "prompt": "solve it",
            "sessionId": "session-1",
            "renderedSystem": "You are careful.",
            "agentConfig": {
                "modelSpec": "anthropic/claude-opus-4-8",
                "maxTurns": 12,
                "permissionMode": "bypass",
                "cwd": "repo",
            },
        }
    )

    assert options.tools == {"type": "preset", "preset": "claude_code"}
    assert options.system_prompt == {
        "type": "preset",
        "preset": "claude_code",
        "append": "You are careful.",
    }
    assert options.model == "claude-opus-4-8"
    assert options.max_turns == 12
    assert options.permission_mode == "bypassPermissions"
    assert options.cwd == str(tmp_path / "repo")
    assert options.session_id is not None


def test_system_prompt_uses_plain_preset_without_append_when_empty() -> None:
    assert system_prompt_config("") == {"type": "preset", "preset": "claude_code"}


def test_permission_mode_falls_back_to_headless_safe_value() -> None:
    assert normalize_permission_mode("acceptEdits") == "acceptEdits"
    assert normalize_permission_mode("unexpected") == "bypassPermissions"


def test_resolve_cwd_creates_absolute_directory(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("src.claude_sdk_runner.DEFAULT_CWD", str(tmp_path))
    resolved = resolve_cwd("repo")
    assert resolved == Path(tmp_path / "repo")
    assert resolved.exists()


def test_extracts_swebench_environment_from_turn_input() -> None:
    environment = swebench_environment(
        {
            "environmentConfig": {
                "swebenchInferenceEnvironment": {
                    "repo": "sympy/sympy",
                    "baseCommit": "abc123",
                    "workspaceRoot": "/sandbox/repo",
                }
            }
        }
    )

    assert environment is not None
    assert environment["repo"] == "sympy/sympy"
    assert environment["baseCommit"] == "abc123"


def test_captures_git_model_patch(tmp_path) -> None:
    if not shutil.which("git"):
        return
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    source = repo / "src"
    source.mkdir()
    module = source / "solver.py"
    module.write_text("def solve():\n    return 1\n")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=repo, check=True)
    module.write_text("def solve():\n    return 2\n")

    patch = capture_git_model_patch(repo, "HEAD")

    assert "diff --git a/src/solver.py b/src/solver.py" in patch
    assert "return 2" in patch
