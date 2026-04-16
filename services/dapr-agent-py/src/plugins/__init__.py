"""Plugin system for dapr-agent-py.

Ported from claude-code-src/main/plugins/ and utils/plugins/.

Provides a manifest-based plugin system supporting:
- Builtin plugins (registered at startup)
- Installed/marketplace plugins (from cached directories)
- Session plugins (ephemeral, from --plugin-dir)

Plugins can provide: skills, hooks, MCP server configs, commands, agents.
"""

from __future__ import annotations

from .builtin import init_builtin_plugins, register_builtin_plugin
from .hooks_integration import register_plugin_hooks
from .identifier import build_plugin_id, parse_plugin_id
from .loader import create_plugin_from_path, load_all_plugins
from .models import (
    BuiltinPluginDefinition,
    LoadedPlugin,
    PluginError,
    PluginLoadResult,
    PluginManifest,
)
from .operations import (
    disable_plugin,
    enable_plugin,
    install_plugin,
    reload_plugins,
    uninstall_plugin,
)
from .registry import PluginRegistry, get_plugin_registry
from .skills_integration import register_plugin_skills

__all__ = [
    "BuiltinPluginDefinition",
    "LoadedPlugin",
    "PluginError",
    "PluginLoadResult",
    "PluginManifest",
    "PluginRegistry",
    "build_plugin_id",
    "create_plugin_from_path",
    "disable_plugin",
    "enable_plugin",
    "get_plugin_registry",
    "init_builtin_plugins",
    "install_plugin",
    "load_all_plugins",
    "parse_plugin_id",
    "register_builtin_plugin",
    "register_plugin_hooks",
    "register_plugin_skills",
    "reload_plugins",
    "uninstall_plugin",
]
