"""Service-boot wiring for hooks + plugins.

bootstrap(agent) attaches:
    agent._hook_registry               HookRegistry (mutable, startup source)
    agent._plugin_registry             PluginRegistry
    agent._hooks_snapshot_by_instance  per-workflow-instance snapshot cache

Called exactly once from main.py after the OpenShellDurableAgent is
constructed, before `runner.serve(...)`. Idempotent: calling it again is
a no-op (protected by an attribute sentinel).
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

from ..hooks import (
    HookRegistry,
    HooksSettings,
    HooksSnapshot,
    hooks_enabled,
    load_cascade,
    policy_flags,
)
from ..hooks.registry import empty_snapshot
from .loader import LoadedPlugin, load_plugins
from .registry import PluginRegistry, build_registry

logger = logging.getLogger(__name__)


_SENTINEL = "_hook_bootstrap_done"


def plugins_enabled() -> bool:
    return os.environ.get("DAPR_AGENT_PY_PLUGINS_ENABLED", "false").lower() in {"1", "true", "yes"}


def _build_hook_registry(
    plugin_registry: PluginRegistry,
) -> HookRegistry:
    hook_registry = HookRegistry()
    cascade = load_cascade()
    disable_all, managed_only = policy_flags(cascade)
    if disable_all:
        logger.info("[hooks] disableAllHooks=true; no hooks registered")
        return hook_registry

    for ls in cascade:
        if managed_only and ls.source != "managed":
            continue
        hook_registry.register_from_settings(ls.hooks, source=ls.source)

    if not managed_only and plugins_enabled():
        plugin_registry.apply_to_hooks(hook_registry)
    elif managed_only:
        logger.info("[hooks] allowManagedHooksOnly=true; skipping plugin hooks")
    return hook_registry


def bootstrap(agent: Any) -> None:
    """Wire hooks + plugins onto the durable agent.

    Safe to call even when `DAPR_AGENT_PY_HOOKS_ENABLED=false` — we still
    attach the (empty) attributes so downstream code has stable shape.
    """
    if getattr(agent, _SENTINEL, False):
        return

    plugins: list[LoadedPlugin] = []
    if plugins_enabled():
        plugins = load_plugins()
    plugin_registry = build_registry(plugins)

    if hooks_enabled():
        hook_registry = _build_hook_registry(plugin_registry)
    else:
        hook_registry = HookRegistry()
        logger.info("[hooks] DAPR_AGENT_PY_HOOKS_ENABLED=false; hook registry empty")

    snapshot = hook_registry.snapshot() if hook_registry.events() else empty_snapshot()

    agent._hook_registry = hook_registry
    agent._plugin_registry = plugin_registry
    agent._base_hooks_snapshot = snapshot
    agent._hooks_snapshot_by_instance = {}
    setattr(agent, _SENTINEL, True)

    counts = snapshot.count_by_event()
    if counts:
        logger.info("[hooks] registered: %s", counts)
    if plugins:
        logger.info(
            "[plugins] loaded %d plugin(s); %d enabled",
            len(plugin_registry.all_plugins),
            len(plugin_registry.enabled_ids),
        )


def current_snapshot(agent: Any, instance_id: str) -> HooksSnapshot:
    """Return the snapshot for the given workflow instance.

    First call for an instance captures a fresh snapshot; subsequent calls
    reuse it so hot-reloads don't retroactively affect in-flight runs.
    """
    cache = getattr(agent, "_hooks_snapshot_by_instance", None)
    if cache is None:
        return empty_snapshot()
    cached = cache.get(instance_id)
    if cached is not None:
        return cached
    logger.info(
        "[hooks-debug] current_snapshot MISS instance=%s cache_keys=%s",
        instance_id,
        list(cache.keys()),
    )
    base = getattr(agent, "_base_hooks_snapshot", None) or empty_snapshot()
    cache[instance_id] = base
    return base


def install_instance_snapshot(
    agent: Any,
    instance_id: str,
    snapshot: HooksSnapshot,
) -> None:
    cache = getattr(agent, "_hooks_snapshot_by_instance", None)
    if cache is None:
        cache = {}
        agent._hooks_snapshot_by_instance = cache
    cache[instance_id] = snapshot
    logger.info(
        "[hooks-debug] install_instance_snapshot instance=%s events=%s cache_id=%s",
        instance_id,
        list(snapshot.by_event.keys()),
        id(cache),
    )


def clear_instance_snapshot(agent: Any, instance_id: str) -> None:
    cache = getattr(agent, "_hooks_snapshot_by_instance", None)
    if isinstance(cache, dict):
        cache.pop(instance_id, None)


__all__ = [
    "bootstrap",
    "current_snapshot",
    "install_instance_snapshot",
    "clear_instance_snapshot",
    "plugins_enabled",
]
