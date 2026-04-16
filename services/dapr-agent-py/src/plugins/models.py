"""Plugin data models.

Ported from claude-code-src/main/types/plugin.ts.
Follows the same dataclass pattern as ``SkillDefinition`` in
``src/tools/skill_tool/models.py``.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any, Callable


class PluginSource(str, enum.Enum):
    BUILTIN = "builtin"
    MARKETPLACE = "marketplace"
    SESSION = "session"  # from --plugin-dir or session_plugin_dirs


@dataclass(frozen=True)
class PluginAuthor:
    name: str
    email: str = ""
    url: str = ""


@dataclass(frozen=True)
class PluginManifest:
    """Plugin manifest (from plugin.json or .claude-plugin/plugin.json).

    Mirrors the TS ``PluginManifest`` type.
    """

    name: str
    version: str = ""
    description: str = ""
    author: PluginAuthor | None = None
    homepage: str = ""
    repository: str = ""
    license: str = ""
    keywords: tuple[str, ...] = ()
    # Component paths (relative to plugin root)
    commands: str | tuple[str, ...] | None = None
    agents: str | tuple[str, ...] | None = None
    skills: str | tuple[str, ...] | None = None
    hooks: str | dict | None = None  # Path to hooks.json or inline dict
    mcp_servers: dict[str, dict] | None = None
    lsp_servers: dict[str, dict] | None = None
    dependencies: tuple[str, ...] = ()


@dataclass
class LoadedPlugin:
    """Runtime representation of a loaded plugin.

    Mutable during loading, then conceptually frozen once registered.
    """

    name: str
    manifest: PluginManifest
    path: str  # Absolute filesystem path (or "builtin" sentinel)
    source: str  # Full ID like "my-plugin@marketplace-name"
    enabled: bool = True
    is_builtin: bool = False
    # Resolved absolute paths (set by loader)
    commands_path: str | None = None
    commands_paths: list[str] = field(default_factory=list)
    agents_path: str | None = None
    agents_paths: list[str] = field(default_factory=list)
    skills_path: str | None = None
    skills_paths: list[str] = field(default_factory=list)
    hooks_config: dict | None = None  # Parsed hooks content
    mcp_servers: dict[str, dict] | None = None
    lsp_servers: dict[str, dict] | None = None


@dataclass(frozen=True)
class PluginError:
    """Describes a plugin loading or runtime error."""

    type: str  # "generic-error", "manifest-parse-error", "path-not-found", etc.
    source: str  # Plugin ID or path
    plugin: str = ""
    message: str = ""


@dataclass(frozen=True)
class PluginLoadResult:
    """Result of loading plugins from all sources."""

    enabled: tuple[LoadedPlugin, ...] = ()
    disabled: tuple[LoadedPlugin, ...] = ()
    errors: tuple[PluginError, ...] = ()


@dataclass(frozen=True)
class BuiltinPluginDefinition:
    """Definition for a builtin plugin (registered at startup).

    Mirrors ``BuiltinPluginDefinition`` in builtinPlugins.ts.
    """

    name: str
    description: str
    version: str = ""
    skills: list[Any] | None = None  # SkillDefinition list
    hooks: dict | None = None  # HooksSettings dict
    mcp_servers: dict[str, dict] | None = None
    default_enabled: bool = True
    is_available: Callable[[], bool] | None = None
