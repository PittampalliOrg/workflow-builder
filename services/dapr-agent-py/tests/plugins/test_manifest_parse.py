"""Plugin manifest parsing — round-trip TS-shaped plugin.json."""
from __future__ import annotations

from src.plugins.manifest import PluginManifest


def test_minimal_manifest():
    m = PluginManifest.model_validate({"name": "test-plugin"})
    assert m.name == "test-plugin"
    assert m.version == "0.1.0"
    assert m.hooks is None
    assert m.mcp_servers is None


def test_manifest_with_hooks_inline():
    m = PluginManifest.model_validate(
        {
            "name": "guardrails",
            "version": "1.2.3",
            "description": "Block dangerous commands",
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [{"type": "command", "command": "guard"}],
                    }
                ]
            },
        }
    )
    assert m.name == "guardrails"
    assert m.hooks is not None
    assert isinstance(m.hooks, dict)
    assert "PreToolUse" in m.hooks


def test_manifest_with_hooks_path_string():
    m = PluginManifest.model_validate({"name": "x", "hooks": "./hooks/hooks.json"})
    assert m.hooks == "./hooks/hooks.json"


def test_mcp_servers_ts_alias():
    m = PluginManifest.model_validate(
        {
            "name": "x",
            "mcpServers": {
                "weather": {"command": "python", "args": ["server.py"]},
            },
        }
    )
    assert m.mcp_servers is not None
    assert "weather" in m.mcp_servers


def test_unknown_fields_ignored():
    m = PluginManifest.model_validate(
        {
            "name": "x",
            "someRandomFutureField": {"nested": "value"},
        }
    )
    assert m.name == "x"


def test_user_config_parsed():
    m = PluginManifest.model_validate(
        {
            "name": "x",
            "userConfig": {
                "API_KEY": {
                    "type": "password",
                    "description": "Service API key",
                    "sensitive": True,
                },
            },
        }
    )
    assert m.user_config is not None
    assert "API_KEY" in m.user_config
    assert m.user_config["API_KEY"].sensitive is True


def test_author_as_string():
    m = PluginManifest.model_validate({"name": "x", "author": "jane@example.com"})
    assert m.author == "jane@example.com"


def test_author_as_object():
    m = PluginManifest.model_validate(
        {"name": "x", "author": {"name": "Jane", "email": "jane@example.com"}}
    )
    assert m.author is not None
