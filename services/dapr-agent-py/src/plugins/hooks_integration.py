"""Plugin → HookRegistry integration.

Converts plugin hook configurations into HookMatcher objects and
registers them with the hook system.
"""

from __future__ import annotations

import logging
from typing import Any

from .models import LoadedPlugin

logger = logging.getLogger(__name__)


def register_plugin_hooks(
    plugins: list[LoadedPlugin] | tuple[LoadedPlugin, ...],
) -> None:
    """Parse hook configs from enabled plugins and register with HookRegistry.

    Each plugin's ``hooks_config`` is a dict in the standard format::

        {
            "PreToolUse": [
                {"matcher": "Write", "hooks": [{"type": "command", ...}]}
            ]
        }
    """
    from src.hooks.config import parse_hooks_settings
    from src.hooks.registry import get_hook_registry
    from src.hooks.types import HookEvent, HookMatcher

    registry = get_hook_registry()
    total = 0

    for plugin in plugins:
        if not plugin.enabled:
            continue
        if not plugin.hooks_config:
            continue

        parsed = parse_hooks_settings(plugin.hooks_config)
        for event, matchers in parsed.items():
            # Annotate matchers with plugin context
            for m in matchers:
                m.plugin_root = plugin.path
                m.plugin_id = plugin.source
            registry.register_hooks(event, matchers)
            total += len(matchers)

    if total:
        logger.info("[plugins] Registered %d hook matcher(s) from plugins", total)
