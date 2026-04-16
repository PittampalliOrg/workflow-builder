"""Plugin registry — enabled-state tracking + dep resolution + application.

Dependency resolution: topological sort over `dependencies`. A plugin is
enabled only if: (a) the user enabled it (or defaults to enabled + no
explicit disable), AND (b) all of its declared dependencies are also
enabled. Cycles -> warn and disable the whole cycle.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Iterable, Optional

from ..hooks.registry import HookRegistry
from .loader import LoadedPlugin
from .manifest import PluginDependencyRef

logger = logging.getLogger(__name__)


@dataclass
class PluginRegistry:
    all_plugins: list[LoadedPlugin]
    enabled_ids: set[str]

    def enabled(self) -> list[LoadedPlugin]:
        return [p for p in self.all_plugins if p.plugin_id in self.enabled_ids]

    def disabled(self) -> list[LoadedPlugin]:
        return [p for p in self.all_plugins if p.plugin_id not in self.enabled_ids]

    def apply_to_hooks(self, hook_registry: HookRegistry) -> None:
        for plugin in self.enabled():
            hook_registry.register_from_plugin(
                plugin_id=plugin.plugin_id,
                plugin_root=str(plugin.root),
                settings=plugin.hooks,
            )

    def plugin_mcp_servers(self) -> list[dict[str, object]]:
        """Flat list of MCP server dicts across enabled plugins.

        Each dict is tagged with `_plugin_id` and `_plugin_root` so
        downstream code can apply ${CLAUDE_PLUGIN_*} substitution.
        """
        out: list[dict[str, object]] = []
        for plugin in self.enabled():
            for entry in plugin.mcp_servers:
                tagged = dict(entry)
                tagged.setdefault("_plugin_id", plugin.plugin_id)
                tagged.setdefault("_plugin_root", str(plugin.root))
                out.append(tagged)
        return out


def _dep_name(ref: object) -> str | None:
    if isinstance(ref, str):
        return ref.strip() or None
    if isinstance(ref, PluginDependencyRef):
        return ref.name.strip() or None
    if isinstance(ref, dict):
        name = ref.get("name")
        return str(name).strip() if name else None
    return None


def _resolve_dependencies(
    plugins_by_id: dict[str, LoadedPlugin],
    candidate_ids: set[str],
) -> set[str]:
    enabled: set[str] = set()
    pending = set(candidate_ids)
    progress = True
    while pending and progress:
        progress = False
        for pid in list(pending):
            plugin = plugins_by_id.get(pid)
            if plugin is None:
                pending.discard(pid)
                continue
            deps = plugin.manifest.dependencies or []
            dep_names = [_dep_name(d) for d in deps]
            dep_names = [d for d in dep_names if d]
            if all(d in enabled or d not in plugins_by_id for d in dep_names):
                # enabled if all known deps are already enabled; unknown deps skipped (warn)
                for d in dep_names:
                    if d not in plugins_by_id:
                        logger.warning(
                            "[plugins] %s declares unknown dependency %s (ignored)",
                            pid,
                            d,
                        )
                enabled.add(pid)
                pending.discard(pid)
                progress = True
    if pending:
        logger.warning(
            "[plugins] dependency cycle or unresolvable dep blocks plugins: %s",
            sorted(pending),
        )
    return enabled


def build_registry(
    loaded: Iterable[LoadedPlugin],
    explicit_enabled: Optional[set[str]] = None,
) -> PluginRegistry:
    """Produce a PluginRegistry honoring an optional explicit allowlist.

    If `explicit_enabled` is None, all loaded plugins are candidates
    (they already passed manifest validation). The final set is the
    subset whose dependency graph resolves cleanly.
    """
    plugins = list(loaded)
    by_id: dict[str, LoadedPlugin] = {p.plugin_id: p for p in plugins}
    candidates = set(by_id.keys()) if explicit_enabled is None else set(explicit_enabled) & set(by_id.keys())
    enabled_ids = _resolve_dependencies(by_id, candidates)
    return PluginRegistry(all_plugins=plugins, enabled_ids=enabled_ids)


__all__ = ["PluginRegistry", "build_registry"]
