"""End-to-end tests for the plugins system.

Tests manifest loading, plugin discovery, registry, integration with
hooks and skills, and plugin operations.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import textwrap
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from plugins.models import (
    BuiltinPluginDefinition,
    LoadedPlugin,
    PluginAuthor,
    PluginError,
    PluginLoadResult,
    PluginManifest,
    PluginSource,
)
from plugins.identifier import ParsedPluginId, build_plugin_id, parse_plugin_id
from plugins.directories import (
    get_plugin_cache_path,
    get_plugin_data_dir,
    get_plugins_directory,
)
from plugins.variables import substitute_plugin_variables
from plugins.validation import validate_manifest, validate_path_within_base
from plugins.config import PluginSettings, load_plugin_settings
from plugins.registry import PluginRegistry
from plugins.builtin import (
    get_builtin_plugins,
    init_builtin_plugins,
    register_builtin_plugin,
)
from plugins.loader import (
    create_plugin_from_path,
    load_all_plugins,
    load_plugin_manifest,
)


# ============================================================================
# Models
# ============================================================================


class TestPluginManifest:
    def test_minimal(self):
        m = PluginManifest(name="test")
        assert m.name == "test"
        assert m.version == ""
        assert m.commands is None
        assert m.mcp_servers is None

    def test_frozen(self):
        m = PluginManifest(name="test")
        with pytest.raises(AttributeError):
            m.name = "other"  # type: ignore

    def test_full(self):
        m = PluginManifest(
            name="full",
            version="1.0.0",
            description="A test plugin",
            author=PluginAuthor(name="Alice", email="a@b.com"),
            keywords=("test", "demo"),
            commands="commands/",
            skills=("skills/a", "skills/b"),
            hooks={"PreToolUse": []},
            mcp_servers={"server1": {"transport": "stdio"}},
            dependencies=("dep1", "dep2"),
        )
        assert m.author.name == "Alice"
        assert len(m.keywords) == 2
        assert len(m.dependencies) == 2


class TestLoadedPlugin:
    def test_mutable(self):
        p = LoadedPlugin(
            name="test",
            manifest=PluginManifest(name="test"),
            path="/opt/test",
            source="test@local",
        )
        p.enabled = False
        assert not p.enabled


# ============================================================================
# Identifier
# ============================================================================


class TestIdentifier:
    def test_parse_with_marketplace(self):
        pid = parse_plugin_id("my-plugin@github")
        assert pid.name == "my-plugin"
        assert pid.marketplace == "github"

    def test_parse_without_marketplace(self):
        pid = parse_plugin_id("my-plugin")
        assert pid.name == "my-plugin"
        assert pid.marketplace == ""

    def test_build(self):
        assert build_plugin_id("foo", "bar") == "foo@bar"
        assert build_plugin_id("foo") == "foo"


# ============================================================================
# Variables
# ============================================================================


class TestVariables:
    def test_substitute_plugin_root(self):
        result = substitute_plugin_variables(
            "path=${PLUGIN_ROOT}/bin",
            "/opt/plugins/test",
            "test@local",
        )
        assert result == "path=/opt/plugins/test/bin"

    def test_substitute_plugin_data(self):
        result = substitute_plugin_variables(
            "data=${PLUGIN_DATA}/state.json",
            "/opt/plugins/test",
            "test@local",
        )
        expected_data_dir = str(get_plugin_data_dir("test@local"))
        assert result == f"data={expected_data_dir}/state.json"

    def test_substitute_options(self):
        result = substitute_plugin_variables(
            "token=${PLUGIN_OPTIONS:api_key}",
            "/opt/plugins/test",
            "test@local",
            options={"api_key": "secret123"},
        )
        assert result == "token=secret123"

    def test_no_substitution(self):
        result = substitute_plugin_variables("no vars here", "/opt", "test@local")
        assert result == "no vars here"


# ============================================================================
# Validation
# ============================================================================


class TestValidation:
    def test_path_within_base(self):
        assert validate_path_within_base("subdir/file.txt", "/opt/plugin")
        assert not validate_path_within_base("../../etc/passwd", "/opt/plugin")

    def test_validate_manifest_ok(self):
        m = PluginManifest(name="valid")
        errors = validate_manifest(m, "/opt/plugin")
        assert len(errors) == 0

    def test_validate_manifest_missing_name(self):
        m = PluginManifest(name="")
        errors = validate_manifest(m, "/opt/plugin")
        assert any(e.type == "manifest-validation-error" for e in errors)


# ============================================================================
# Registry
# ============================================================================


class TestPluginRegistry:
    def test_register_and_lookup(self):
        reg = PluginRegistry()
        plugin = LoadedPlugin(
            name="test",
            manifest=PluginManifest(name="test"),
            path="/opt/test",
            source="test@local",
        )
        reg.register(plugin)
        assert reg.get("test@local") is plugin
        assert len(reg.list_enabled()) == 1

    def test_enable_disable(self):
        reg = PluginRegistry()
        plugin = LoadedPlugin(
            name="test",
            manifest=PluginManifest(name="test"),
            path="/opt/test",
            source="test@local",
        )
        reg.register(plugin)
        reg.set_enabled("test@local", False)
        assert len(reg.list_enabled()) == 0
        assert len(reg.list_disabled()) == 1

    def test_unregister(self):
        reg = PluginRegistry()
        plugin = LoadedPlugin(
            name="test",
            manifest=PluginManifest(name="test"),
            path="/opt/test",
            source="test@local",
        )
        reg.register(plugin)
        reg.unregister("test@local")
        assert reg.get("test@local") is None

    def test_set_load_result(self):
        reg = PluginRegistry()
        p1 = LoadedPlugin(
            name="a", manifest=PluginManifest(name="a"), path="/a", source="a@x", enabled=True
        )
        p2 = LoadedPlugin(
            name="b", manifest=PluginManifest(name="b"), path="/b", source="b@x", enabled=False
        )
        reg.set_load_result(PluginLoadResult(enabled=(p1,), disabled=(p2,)))
        assert len(reg.list_all()) == 2
        assert reg.get_load_result() is not None

    def test_clear(self):
        reg = PluginRegistry()
        reg.register(
            LoadedPlugin(name="t", manifest=PluginManifest(name="t"), path="/t", source="t@x")
        )
        reg.clear()
        assert len(reg.list_all()) == 0


# ============================================================================
# Builtin plugins
# ============================================================================


class TestBuiltinPlugins:
    def test_register_and_load(self):
        # Use a unique name to avoid test interference
        register_builtin_plugin(
            BuiltinPluginDefinition(
                name="test-e2e-builtin",
                description="E2E test builtin",
                default_enabled=True,
            )
        )
        settings = PluginSettings()
        enabled, disabled = get_builtin_plugins(settings)
        found = [p for p in enabled if p.name == "test-e2e-builtin"]
        assert len(found) == 1
        assert found[0].is_builtin

    def test_disabled_by_settings(self):
        register_builtin_plugin(
            BuiltinPluginDefinition(
                name="test-disabled-builtin",
                description="Should be disabled",
                default_enabled=True,
            )
        )
        settings = PluginSettings(
            enabled_plugins={"test-disabled-builtin@builtin": False}
        )
        enabled, disabled = get_builtin_plugins(settings)
        found_enabled = [p for p in enabled if p.name == "test-disabled-builtin"]
        found_disabled = [p for p in disabled if p.name == "test-disabled-builtin"]
        assert len(found_enabled) == 0
        assert len(found_disabled) == 1

    def test_unavailable(self):
        register_builtin_plugin(
            BuiltinPluginDefinition(
                name="test-unavailable",
                description="Not available",
                is_available=lambda: False,
            )
        )
        settings = PluginSettings()
        enabled, disabled = get_builtin_plugins(settings)
        found = [p for p in enabled + disabled if p.name == "test-unavailable"]
        assert len(found) == 0


# ============================================================================
# Manifest loading and plugin creation from directory
# ============================================================================


class TestPluginLoader:
    def test_load_manifest(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = {
                "name": "test-plugin",
                "version": "1.0.0",
                "description": "A test plugin",
            }
            manifest_path = Path(tmpdir) / "plugin.json"
            with open(manifest_path, "w") as f:
                json.dump(manifest, f)

            result = load_plugin_manifest(manifest_path, "fallback")
            assert result is not None
            assert result.name == "test-plugin"
            assert result.version == "1.0.0"

    def test_load_manifest_missing(self):
        result = load_plugin_manifest(Path("/nonexistent/plugin.json"), "fallback")
        assert result is None

    def test_load_manifest_claude_plugin_dir(self):
        """Manifest at .claude-plugin/plugin.json should be found."""
        with tempfile.TemporaryDirectory() as tmpdir:
            dot_dir = Path(tmpdir) / ".claude-plugin"
            dot_dir.mkdir()
            manifest = {"name": "dotdir-plugin", "version": "0.1.0"}
            with open(dot_dir / "plugin.json", "w") as f:
                json.dump(manifest, f)

            plugin, errors = create_plugin_from_path(
                Path(tmpdir), source="test@local", enabled=True, fallback_name="fb"
            )
            assert plugin.name == "dotdir-plugin"

    def test_create_plugin_auto_detect_dirs(self):
        """Auto-detects commands/, skills/, agents/ directories."""
        with tempfile.TemporaryDirectory() as tmpdir:
            for subdir in ("commands", "agents", "skills"):
                (Path(tmpdir) / subdir).mkdir()
            # No manifest — should create minimal plugin
            plugin, errors = create_plugin_from_path(
                Path(tmpdir), source="test@local", enabled=True, fallback_name="auto"
            )
            assert plugin.name == "auto"
            assert plugin.commands_path is not None
            assert plugin.agents_path is not None
            assert plugin.skills_path is not None

    def test_create_plugin_with_hooks(self):
        """Plugin with hooks/hooks.json gets hooks loaded."""
        with tempfile.TemporaryDirectory() as tmpdir:
            hooks_dir = Path(tmpdir) / "hooks"
            hooks_dir.mkdir()
            hooks_json = {
                "hooks": {
                    "PreToolUse": [
                        {
                            "matcher": "Write",
                            "hooks": [
                                {"type": "command", "command": "validate.sh"}
                            ],
                        }
                    ]
                }
            }
            with open(hooks_dir / "hooks.json", "w") as f:
                json.dump(hooks_json, f)

            plugin, errors = create_plugin_from_path(
                Path(tmpdir),
                source="test@local",
                enabled=True,
                fallback_name="hooked",
            )
            assert plugin.hooks_config is not None
            assert "PreToolUse" in plugin.hooks_config

    def test_create_plugin_with_mcp_json(self):
        """Plugin with .mcp.json gets MCP servers loaded."""
        with tempfile.TemporaryDirectory() as tmpdir:
            mcp_json = {
                "mcpServers": {
                    "test-server": {
                        "transport": "stdio",
                        "command": "node",
                        "args": ["server.js"],
                    }
                }
            }
            with open(Path(tmpdir) / ".mcp.json", "w") as f:
                json.dump(mcp_json, f)

            plugin, errors = create_plugin_from_path(
                Path(tmpdir),
                source="test@local",
                enabled=True,
                fallback_name="mcp-plugin",
            )
            assert plugin.mcp_servers is not None
            assert "test-server" in plugin.mcp_servers

    def test_create_plugin_manifest_specified_hooks(self):
        """Plugin manifest can inline hooks directly."""
        with tempfile.TemporaryDirectory() as tmpdir:
            manifest = {
                "name": "inline-hooks",
                "hooks": {
                    "SessionStart": [
                        {
                            "matcher": "startup",
                            "hooks": [
                                {"type": "command", "command": "setup.sh"}
                            ],
                        }
                    ]
                },
            }
            with open(Path(tmpdir) / "plugin.json", "w") as f:
                json.dump(manifest, f)

            plugin, errors = create_plugin_from_path(
                Path(tmpdir),
                source="test@local",
                enabled=True,
                fallback_name="fb",
            )
            assert plugin.hooks_config is not None
            assert "SessionStart" in plugin.hooks_config


# ============================================================================
# Full E2E: plugin with hooks → hook system
# ============================================================================


class TestPluginHooksIntegration:
    def test_plugin_hooks_registered_in_hook_system(self):
        """Create a plugin on disk with hooks, load it, and verify hooks
        are registered and can execute."""
        from hooks.registry import HookRegistry
        from hooks.types import HookEvent
        from hooks.executor import execute_hooks
        from hooks.types import PreToolUseHookInput

        with tempfile.TemporaryDirectory() as tmpdir:
            # Create plugin with hooks
            hooks_dir = Path(tmpdir) / "hooks"
            hooks_dir.mkdir()
            hooks_json = {
                "hooks": {
                    "PreToolUse": [
                        {
                            "matcher": "Write",
                            "hooks": [
                                {
                                    "type": "command",
                                    "command": "echo '{\"continue\":true,\"hookSpecificOutput\":{\"additionalContext\":\"plugin-validated\"}}'",
                                    "timeout": 5,
                                }
                            ],
                        }
                    ]
                }
            }
            with open(hooks_dir / "hooks.json", "w") as f:
                json.dump(hooks_json, f)

            # Load plugin
            plugin, errors = create_plugin_from_path(
                Path(tmpdir),
                source="test-hook-plugin@local",
                enabled=True,
                fallback_name="hook-plugin",
            )
            assert plugin.hooks_config is not None

            # Register hooks with a fresh HookRegistry
            from hooks.config import parse_hooks_settings

            hook_reg = HookRegistry()
            parsed = parse_hooks_settings(plugin.hooks_config)
            for event, matchers in parsed.items():
                for m in matchers:
                    m.plugin_root = plugin.path
                    m.plugin_id = plugin.source
                hook_reg.register_hooks(event, matchers)

            assert hook_reg.has_hooks_for_event("", HookEvent.PRE_TOOL_USE)

            # Execute hooks using the fresh registry
            from hooks import executor as _executor

            old = _executor.get_hook_registry
            _executor.get_hook_registry = lambda: hook_reg
            try:
                result = execute_hooks(
                    HookEvent.PRE_TOOL_USE,
                    PreToolUseHookInput(
                        hook_event_name=HookEvent.PRE_TOOL_USE,
                        tool_name="Write",
                        tool_input={"file_path": "/test.txt"},
                    ),
                    match_query="Write",
                )
                assert not result.has_blocking_errors
                assert "plugin-validated" in result.additional_contexts
            finally:
                _executor.get_hook_registry = old


# ============================================================================
# Full E2E: plugin with skills (requires skill_tool available)
# ============================================================================


class TestPluginSkillsIntegration:
    def test_plugin_skills_loaded(self):
        """Create a plugin on disk with a SKILL.md, verify it loads."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create plugin with skill
            skills_dir = Path(tmpdir) / "skills" / "my-skill"
            skills_dir.mkdir(parents=True)
            skill_md = textwrap.dedent("""\
                ---
                name: my-plugin-skill
                description: A skill from a plugin
                ---

                This is the skill prompt body.
            """)
            with open(skills_dir / "SKILL.md", "w") as f:
                f.write(skill_md)

            # Load plugin
            plugin, errors = create_plugin_from_path(
                Path(tmpdir),
                source="test-skill-plugin@local",
                enabled=True,
                fallback_name="skill-plugin",
            )
            assert plugin.skills_path is not None

            # Load skills from plugin
            # Need to adjust path for skill_tool import
            sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "tools"))
            from skill_tool.loader import load_skills_from_dir

            skills = load_skills_from_dir(plugin.skills_path, source="plugin")
            assert len(skills) >= 1
            assert any(s.name == "my-plugin-skill" for s in skills)


# ============================================================================
# MCP integration
# ============================================================================


class TestMCPIntegration:
    def test_collect_mcp_servers(self):
        from plugins.mcp_integration import collect_plugin_mcp_servers

        p1 = LoadedPlugin(
            name="p1",
            manifest=PluginManifest(name="p1"),
            path="/opt/p1",
            source="p1@local",
            enabled=True,
            mcp_servers={
                "server-a": {"transport": "stdio", "command": "${PLUGIN_ROOT}/bin/server"}
            },
        )
        p2 = LoadedPlugin(
            name="p2",
            manifest=PluginManifest(name="p2"),
            path="/opt/p2",
            source="p2@local",
            enabled=True,
            mcp_servers={
                "server-b": {"transport": "sse", "url": "http://localhost:3000"}
            },
        )
        merged = collect_plugin_mcp_servers([p1, p2])
        assert "server-a" in merged
        assert "server-b" in merged
        # Variable substitution should have replaced ${PLUGIN_ROOT}
        assert merged["server-a"]["command"] == "/opt/p1/bin/server"

    def test_duplicate_server_name(self):
        from plugins.mcp_integration import collect_plugin_mcp_servers

        p1 = LoadedPlugin(
            name="p1",
            manifest=PluginManifest(name="p1"),
            path="/opt/p1",
            source="p1@local",
            enabled=True,
            mcp_servers={"dup-server": {"transport": "stdio"}},
        )
        p2 = LoadedPlugin(
            name="p2",
            manifest=PluginManifest(name="p2"),
            path="/opt/p2",
            source="p2@local",
            enabled=True,
            mcp_servers={"dup-server": {"transport": "sse"}},
        )
        merged = collect_plugin_mcp_servers([p1, p2])
        # First one wins, duplicate is skipped
        assert merged["dup-server"]["transport"] == "stdio"

    def test_disabled_plugin_excluded(self):
        from plugins.mcp_integration import collect_plugin_mcp_servers

        p = LoadedPlugin(
            name="disabled",
            manifest=PluginManifest(name="disabled"),
            path="/opt/d",
            source="d@local",
            enabled=False,
            mcp_servers={"server-x": {"transport": "stdio"}},
        )
        merged = collect_plugin_mcp_servers([p])
        assert len(merged) == 0
