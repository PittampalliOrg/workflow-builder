"""Plugin identifier parsing.

Ported from claude-code-src/main/utils/plugins/pluginIdentifier.ts.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ParsedPluginId:
    """Parsed components of a plugin identifier."""

    name: str
    marketplace: str = ""


def parse_plugin_id(plugin_id: str) -> ParsedPluginId:
    """Parse ``name@marketplace`` into components."""
    if "@" in plugin_id:
        name, marketplace = plugin_id.split("@", 1)
        return ParsedPluginId(name=name, marketplace=marketplace)
    return ParsedPluginId(name=plugin_id)


def build_plugin_id(name: str, marketplace: str = "") -> str:
    """Build a plugin ID from components."""
    if marketplace:
        return f"{name}@{marketplace}"
    return name
