"""Built-in plugin scaffolding.

v1 ships no built-ins. The registry exists so future code can move
today's hard-coded behaviors (checkpoint capture, etc.) behind the
plugin surface without an architecture change.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from ..hooks.schemas import HooksSettings


@dataclass
class BuiltinPlugin:
    name: str
    version: str
    description: str = ""
    hooks: HooksSettings = None  # type: ignore[assignment]
    default_enabled: bool = True

    def __post_init__(self) -> None:
        if self.hooks is None:
            self.hooks = HooksSettings()


BUILTIN_PLUGINS: dict[str, BuiltinPlugin] = {}


def register_builtin_plugin(plugin: BuiltinPlugin) -> None:
    BUILTIN_PLUGINS[plugin.name] = plugin


def get_builtin_plugins() -> list[BuiltinPlugin]:
    return list(BUILTIN_PLUGINS.values())


__all__ = ["BuiltinPlugin", "BUILTIN_PLUGINS", "register_builtin_plugin", "get_builtin_plugins"]
