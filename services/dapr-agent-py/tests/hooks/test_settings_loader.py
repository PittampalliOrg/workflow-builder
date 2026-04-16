"""Settings cascade loader."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from src.hooks.settings_loader import load_cascade, policy_flags


@pytest.fixture
def isolated_home(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(project))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("DAPR_AGENT_PY_MANAGED_SETTINGS", raising=False)
    monkeypatch.delenv("DAPR_AGENT_PY_EXTRA_SETTINGS_PATHS", raising=False)
    return project, home


def _write(path: Path, body: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body))


def test_missing_files_return_empty_cascade(isolated_home):
    loaded = load_cascade()
    assert all(ls.hooks.root == {} for ls in loaded)


def test_user_settings_loaded(isolated_home):
    project, home = isolated_home
    _write(
        home / ".claude" / "settings.json",
        {
            "hooks": {
                "PreToolUse": [
                    {"matcher": "Bash", "hooks": [{"type": "command", "command": "u"}]}
                ]
            }
        },
    )
    loaded = load_cascade()
    user = next(ls for ls in loaded if ls.source == "user")
    assert "PreToolUse" in user.hooks.root


def test_project_overlay(isolated_home):
    project, home = isolated_home
    _write(
        project / ".claude" / "settings.json",
        {
            "hooks": {
                "PreToolUse": [
                    {"matcher": "Read", "hooks": [{"type": "command", "command": "p"}]}
                ]
            }
        },
    )
    loaded = load_cascade()
    proj = next(ls for ls in loaded if ls.source == "project")
    assert proj.hooks.root["PreToolUse"][0].matcher == "Read"


def test_policy_disable_all_hooks_flag(isolated_home, monkeypatch, tmp_path):
    managed = tmp_path / "policy.json"
    managed.write_text(json.dumps({"disableAllHooks": True}))
    monkeypatch.setenv("DAPR_AGENT_PY_MANAGED_SETTINGS", str(managed))
    loaded = load_cascade()
    disable_all, managed_only = policy_flags(loaded)
    assert disable_all is True


def test_nonmanaged_disable_maps_to_managed_only(isolated_home):
    project, home = isolated_home
    _write(home / ".claude" / "settings.json", {"disableAllHooks": True})
    loaded = load_cascade()
    disable_all, managed_only = policy_flags(loaded)
    assert disable_all is False
    assert managed_only is True


def test_extra_paths_applied(isolated_home, monkeypatch, tmp_path):
    extra = tmp_path / "extra.json"
    extra.write_text(
        json.dumps(
            {
                "hooks": {
                    "PreToolUse": [
                        {"hooks": [{"type": "command", "command": "x"}]}
                    ]
                }
            }
        )
    )
    monkeypatch.setenv("DAPR_AGENT_PY_EXTRA_SETTINGS_PATHS", str(extra))
    loaded = load_cascade()
    managed_entries = [ls for ls in loaded if ls.source == "managed"]
    assert any("PreToolUse" in ls.hooks.root for ls in managed_entries)
