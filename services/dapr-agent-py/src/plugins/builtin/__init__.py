"""Builtin plugin registration.

Ported from claude-code-src/main/plugins/builtinPlugins.ts and
plugins/bundled/index.ts.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable

from ..config import PluginSettings
from ..identifier import build_plugin_id
from ..models import (
    BuiltinPluginDefinition,
    LoadedPlugin,
    PluginManifest,
    PluginSource,
)

logger = logging.getLogger(__name__)

BUILTIN_MARKETPLACE = "builtin"

_lock = threading.Lock()
_definitions: dict[str, BuiltinPluginDefinition] = {}


def register_builtin_plugin(definition: BuiltinPluginDefinition) -> None:
    """Register a builtin plugin definition.  Called at startup."""
    with _lock:
        _definitions[definition.name] = definition
    logger.debug("Registered builtin plugin: %s", definition.name)


def get_builtin_plugin_definition(name: str) -> BuiltinPluginDefinition | None:
    """Look up a builtin plugin definition by name."""
    with _lock:
        return _definitions.get(name)


def is_builtin_plugin_id(plugin_id: str) -> bool:
    """Check if a plugin ID refers to a builtin plugin."""
    return plugin_id.endswith(f"@{BUILTIN_MARKETPLACE}")


def get_builtin_plugins(
    settings: PluginSettings,
) -> tuple[list[LoadedPlugin], list[LoadedPlugin]]:
    """Return (enabled, disabled) builtin plugins based on settings."""
    enabled: list[LoadedPlugin] = []
    disabled: list[LoadedPlugin] = []

    with _lock:
        defs = dict(_definitions)

    for name, defn in defs.items():
        # Check availability
        if defn.is_available is not None and not defn.is_available():
            continue

        plugin_id = build_plugin_id(name, BUILTIN_MARKETPLACE)
        is_enabled = settings.enabled_plugins.get(plugin_id, defn.default_enabled)

        manifest = PluginManifest(
            name=name,
            version=defn.version,
            description=defn.description,
            hooks=defn.hooks,
            mcp_servers=defn.mcp_servers,
        )

        plugin = LoadedPlugin(
            name=name,
            manifest=manifest,
            path="builtin",
            source=plugin_id,
            enabled=is_enabled,
            is_builtin=True,
            hooks_config=defn.hooks,
            mcp_servers=defn.mcp_servers,
        )

        if is_enabled:
            enabled.append(plugin)
        else:
            disabled.append(plugin)

    return enabled, disabled


def init_builtin_plugins() -> None:
    """Register all builtin plugins.  Called once at startup.

    Add future builtin plugin registrations here.
    """
    # Example:
    # register_builtin_plugin(BuiltinPluginDefinition(
    #     name="example-plugin",
    #     description="An example builtin plugin",
    #     default_enabled=True,
    # ))
    pass
