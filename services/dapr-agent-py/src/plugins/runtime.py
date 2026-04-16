"""Per-run overlay from agentConfig trigger message.

Supports two fields on `agentConfig`:
  - `hooks`:   inline HooksSettings applied only for this workflow instance
  - `plugins`: list of plugin IDs to additionally enable for this instance

Per-run hooks always register as source="per_run" so they don't persist
beyond the snapshot captured at workflow start.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from ..hooks.registry import HooksSnapshot, HookRegistry
from ..hooks.schemas import HooksSettings
from .registry import PluginRegistry

logger = logging.getLogger(__name__)


def _coerce_agent_config(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def extract_inline_hooks(message: dict[str, Any]) -> HooksSettings:
    agent_config = _coerce_agent_config(message.get("agentConfig"))
    if not isinstance(agent_config, dict):
        return HooksSettings()
    raw = agent_config.get("hooks")
    if not isinstance(raw, dict):
        return HooksSettings()
    return HooksSettings.from_raw(raw)


def extract_plugin_ids(message: dict[str, Any]) -> list[str]:
    agent_config = _coerce_agent_config(message.get("agentConfig"))
    if not isinstance(agent_config, dict):
        return []
    raw = agent_config.get("plugins")
    if not isinstance(raw, list):
        return []
    return [str(x).strip() for x in raw if str(x).strip()]


def apply_per_run(
    base_snapshot: HooksSnapshot,
    message: dict[str, Any],
    *,
    plugin_registry: PluginRegistry | None = None,
) -> HooksSnapshot:
    """Return a snapshot overlaid with per-run hooks.

    Order of registration (same semantics as plugin.registry):
      1. base snapshot (already ordered: managed -> user -> project -> plugin -> builtin)
      2. additional plugins from `agentConfig.plugins` (treated as plugin source)
      3. inline `agentConfig.hooks` (source=per_run)
    """
    snapshot = base_snapshot
    plugin_ids = extract_plugin_ids(message)
    if plugin_ids and plugin_registry is not None:
        overlay_registry = HookRegistry()
        by_id = {p.plugin_id: p for p in plugin_registry.all_plugins}
        for pid in plugin_ids:
            plugin = by_id.get(pid)
            if plugin is None:
                logger.info("[plugins] per-run plugin %s not found; skipping", pid)
                continue
            if pid in plugin_registry.enabled_ids:
                continue  # already present in base
            overlay_registry.register_from_plugin(
                plugin_id=plugin.plugin_id,
                plugin_root=str(plugin.root),
                settings=plugin.hooks,
            )
        if overlay_registry.events():
            # Merge overlay into a new snapshot by concatenating tuples.
            overlay_snap = overlay_registry.snapshot()
            merged = {event: list(items) for event, items in snapshot.by_event.items()}
            for event, items in overlay_snap.by_event.items():
                merged.setdefault(event, []).extend(items)
            snapshot = HooksSnapshot(
                by_event={event: tuple(items) for event, items in merged.items()}
            )

    inline = extract_inline_hooks(message)
    if inline.root:
        snapshot = snapshot.overlay(inline)
    return snapshot


__all__ = ["apply_per_run", "extract_inline_hooks", "extract_plugin_ids"]
