"""Plugin discovery + file resolution."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.plugins.loader import LoadedPlugin, load_plugins


def _write(path: Path, body) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body) if not isinstance(body, str) else body)


def test_single_plugin_with_inline_hooks(tmp_path):
    plugin_dir = tmp_path / "plugins" / "guardrails"
    plugin_dir.mkdir(parents=True)
    _write(
        plugin_dir / "plugin.json",
        {
            "name": "guardrails",
            "version": "1.0.0",
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [{"type": "command", "command": "guard"}],
                    }
                ]
            },
        },
    )
    plugins = load_plugins([tmp_path / "plugins"])
    assert len(plugins) == 1
    p = plugins[0]
    assert p.plugin_id == "guardrails"
    assert "PreToolUse" in p.hooks.root


def test_plugin_with_hooks_json_file(tmp_path):
    plugin_dir = tmp_path / "plugins" / "p1"
    plugin_dir.mkdir(parents=True)
    _write(plugin_dir / "plugin.json", {"name": "p1", "hooks": "./hooks/hooks.json"})
    _write(
        plugin_dir / "hooks" / "hooks.json",
        {
            "PreToolUse": [
                {"matcher": "Read", "hooks": [{"type": "command", "command": "r"}]}
            ]
        },
    )
    plugins = load_plugins([tmp_path / "plugins"])
    assert plugins[0].hooks.root["PreToolUse"][0].matcher == "Read"


def test_conventional_hooks_file_merged(tmp_path):
    plugin_dir = tmp_path / "plugins" / "p2"
    plugin_dir.mkdir(parents=True)
    _write(
        plugin_dir / "plugin.json",
        {
            "name": "p2",
            "hooks": {
                "PreToolUse": [
                    {"matcher": "Bash", "hooks": [{"type": "command", "command": "a"}]}
                ]
            },
        },
    )
    _write(
        plugin_dir / "hooks" / "hooks.json",
        {
            "PostToolUse": [
                {"matcher": "*", "hooks": [{"type": "command", "command": "b"}]}
            ]
        },
    )
    plugins = load_plugins([tmp_path / "plugins"])
    events = set(plugins[0].hooks.root.keys())
    assert events == {"PreToolUse", "PostToolUse"}


def test_invalid_manifest_skipped(tmp_path):
    plugin_dir = tmp_path / "plugins" / "broken"
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "plugin.json").write_text("not json")
    plugins = load_plugins([tmp_path / "plugins"])
    assert plugins == []


def test_missing_name_rejected(tmp_path):
    plugin_dir = tmp_path / "plugins" / "noname"
    plugin_dir.mkdir(parents=True)
    _write(plugin_dir / "plugin.json", {"version": "1.0"})
    plugins = load_plugins([tmp_path / "plugins"])
    assert plugins == []


def test_hooks_path_escape_blocked(tmp_path):
    plugin_dir = tmp_path / "plugins" / "escape"
    plugin_dir.mkdir(parents=True)
    _write(plugin_dir / "plugin.json", {"name": "escape", "hooks": "../outside.json"})
    outside = tmp_path / "outside.json"
    _write(outside, {"PreToolUse": [{"hooks": [{"type": "command", "command": "x"}]}]})
    plugins = load_plugins([tmp_path / "plugins"])
    # The escape attempt results in empty hooks, not a crash
    assert plugins[0].hooks.root == {}


def test_mcp_servers_map_shape(tmp_path):
    plugin_dir = tmp_path / "plugins" / "mcp-plug"
    plugin_dir.mkdir(parents=True)
    _write(
        plugin_dir / "plugin.json",
        {
            "name": "mcp-plug",
            "mcpServers": {
                "weather": {"command": "python", "args": ["s.py"]},
                "time": {"url": "https://example.com/mcp"},
            },
        },
    )
    plugins = load_plugins([tmp_path / "plugins"])
    mcp = plugins[0].mcp_servers
    assert len(mcp) == 2
    names = {entry.get("server_name") for entry in mcp}
    assert names == {"weather", "time"}
