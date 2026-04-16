"""Thread-safe plugin registry.

Follows the same singleton pattern as ``SkillRegistry`` in
``src/tools/skill_tool/tool.py``.
"""

from __future__ import annotations

import logging
import threading

from .models import LoadedPlugin, PluginLoadResult

logger = logging.getLogger(__name__)


class PluginRegistry:
    """Thread-safe central registry for all loaded plugins."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._plugins: dict[str, LoadedPlugin] = {}  # keyed by source (plugin_id)
        self._load_result: PluginLoadResult | None = None

    # -- mutation --------------------------------------------------------------

    def register(self, plugin: LoadedPlugin) -> None:
        with self._lock:
            self._plugins[plugin.source] = plugin

    def unregister(self, plugin_id: str) -> None:
        with self._lock:
            self._plugins.pop(plugin_id, None)

    def set_enabled(self, plugin_id: str, enabled: bool) -> None:
        with self._lock:
            plugin = self._plugins.get(plugin_id)
            if plugin:
                plugin.enabled = enabled

    def set_load_result(self, result: PluginLoadResult) -> None:
        with self._lock:
            self._load_result = result
            self._plugins.clear()
            for p in result.enabled:
                self._plugins[p.source] = p
            for p in result.disabled:
                self._plugins[p.source] = p

    def clear(self) -> None:
        with self._lock:
            self._plugins.clear()
            self._load_result = None

    # -- lookup ----------------------------------------------------------------

    def get(self, plugin_id: str) -> LoadedPlugin | None:
        with self._lock:
            return self._plugins.get(plugin_id)

    def list_enabled(self) -> list[LoadedPlugin]:
        with self._lock:
            return [p for p in self._plugins.values() if p.enabled]

    def list_disabled(self) -> list[LoadedPlugin]:
        with self._lock:
            return [p for p in self._plugins.values() if not p.enabled]

    def list_all(self) -> list[LoadedPlugin]:
        with self._lock:
            return list(self._plugins.values())

    def get_load_result(self) -> PluginLoadResult | None:
        with self._lock:
            return self._load_result


# Module-level singleton
_registry = PluginRegistry()


def get_plugin_registry() -> PluginRegistry:
    """Return the module-level plugin registry singleton."""
    return _registry
