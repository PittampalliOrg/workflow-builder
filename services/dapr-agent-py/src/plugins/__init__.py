"""Plugin subsystem — manifest parsing, loading, registry, per-run overlay."""
from __future__ import annotations

from .builtin import (
    BUILTIN_PLUGINS,
    BuiltinPlugin,
    get_builtin_plugins,
    register_builtin_plugin,
)
from .integration import (
    bootstrap,
    clear_instance_snapshot,
    current_snapshot,
    install_instance_snapshot,
    plugins_enabled,
)
from .loader import LoadedPlugin, discovery_paths, load_plugins
from .manifest import (
    PluginAuthor,
    PluginDependencyRef,
    PluginManifest,
    PluginManifestMetadata,
    PluginMcpServerEntry,
    PluginUserConfigOption,
)
from .registry import PluginRegistry, build_registry
from .runtime import apply_per_run, extract_inline_hooks, extract_plugin_ids
from .variables import plugin_data_dir, substitute

__all__ = [
    "BuiltinPlugin",
    "BUILTIN_PLUGINS",
    "register_builtin_plugin",
    "get_builtin_plugins",
    "LoadedPlugin",
    "discovery_paths",
    "load_plugins",
    "PluginManifest",
    "PluginManifestMetadata",
    "PluginAuthor",
    "PluginDependencyRef",
    "PluginMcpServerEntry",
    "PluginUserConfigOption",
    "PluginRegistry",
    "build_registry",
    "apply_per_run",
    "extract_inline_hooks",
    "extract_plugin_ids",
    "bootstrap",
    "current_snapshot",
    "install_instance_snapshot",
    "clear_instance_snapshot",
    "plugins_enabled",
    "plugin_data_dir",
    "substitute",
]
