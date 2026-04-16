"""Plugin → MCP server config integration.

Collects MCP server configurations from enabled plugins and merges
them for use by the agent's MCP client.
"""

from __future__ import annotations

import logging
from typing import Any

from .models import LoadedPlugin
from .variables import substitute_plugin_variables

logger = logging.getLogger(__name__)


def collect_plugin_mcp_servers(
    plugins: list[LoadedPlugin] | tuple[LoadedPlugin, ...],
) -> dict[str, dict]:
    """Merge MCP server configs from enabled plugins.

    Applies variable substitution to command/args/env values.
    Logs warnings for duplicate server names.
    """
    merged: dict[str, dict] = {}

    for plugin in plugins:
        if not plugin.enabled:
            continue
        if not plugin.mcp_servers:
            continue

        for server_name, config in plugin.mcp_servers.items():
            if server_name in merged:
                logger.warning(
                    "[plugins] Duplicate MCP server name '%s' from plugin %s — skipping",
                    server_name,
                    plugin.name,
                )
                continue

            # Apply variable substitution to string values in config
            substituted = _substitute_config(config, plugin.path, plugin.source)
            merged[server_name] = substituted

    if merged:
        logger.info("[plugins] Collected %d MCP server(s) from plugins", len(merged))

    return merged


def _substitute_config(
    config: dict,
    plugin_path: str,
    plugin_id: str,
) -> dict:
    """Recursively substitute plugin variables in config values."""
    result: dict = {}
    for key, value in config.items():
        if isinstance(value, str):
            result[key] = substitute_plugin_variables(value, plugin_path, plugin_id)
        elif isinstance(value, dict):
            result[key] = _substitute_config(value, plugin_path, plugin_id)
        elif isinstance(value, list):
            result[key] = [
                substitute_plugin_variables(v, plugin_path, plugin_id)
                if isinstance(v, str)
                else v
                for v in value
            ]
        else:
            result[key] = value
    return result
