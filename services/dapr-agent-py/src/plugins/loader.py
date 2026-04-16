"""Plugin discovery and loading.

Ported from claude-code-src/main/utils/plugins/pluginLoader.ts.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from .models import (
    LoadedPlugin,
    PluginAuthor,
    PluginError,
    PluginLoadResult,
    PluginManifest,
)
from .identifier import build_plugin_id
from .validation import validate_manifest, validate_path_within_base

logger = logging.getLogger(__name__)


def _parse_manifest(raw: dict[str, Any], fallback_name: str) -> PluginManifest:
    """Parse a raw JSON dict into a PluginManifest."""
    author_raw = raw.get("author")
    author = None
    if isinstance(author_raw, dict):
        author = PluginAuthor(
            name=str(author_raw.get("name", "")),
            email=str(author_raw.get("email", "")),
            url=str(author_raw.get("url", "")),
        )

    keywords = raw.get("keywords", ())
    if isinstance(keywords, list):
        keywords = tuple(str(k) for k in keywords)

    deps = raw.get("dependencies", ())
    if isinstance(deps, list):
        deps = tuple(str(d) for d in deps)

    commands = raw.get("commands")
    if isinstance(commands, list):
        commands = tuple(str(c) for c in commands)
    elif isinstance(commands, dict):
        # Object format — extract paths
        commands = tuple(str(v) for v in commands.values() if isinstance(v, str))

    agents = raw.get("agents")
    if isinstance(agents, list):
        agents = tuple(str(a) for a in agents)

    skills = raw.get("skills")
    if isinstance(skills, list):
        skills = tuple(str(s) for s in skills)

    hooks = raw.get("hooks")  # str path, dict, or None

    mcp_servers = raw.get("mcpServers")
    if not isinstance(mcp_servers, dict):
        mcp_servers = None

    lsp_servers = raw.get("lspServers")
    if not isinstance(lsp_servers, dict):
        lsp_servers = None

    return PluginManifest(
        name=str(raw.get("name", fallback_name)),
        version=str(raw.get("version", "")),
        description=str(raw.get("description", "")),
        author=author,
        homepage=str(raw.get("homepage", "")),
        repository=str(raw.get("repository", "")),
        license=str(raw.get("license", "")),
        keywords=keywords,
        commands=commands,
        agents=agents,
        skills=skills,
        hooks=hooks,
        mcp_servers=mcp_servers,
        lsp_servers=lsp_servers,
        dependencies=deps,
    )


def load_plugin_manifest(
    manifest_path: Path,
    fallback_name: str,
) -> PluginManifest | None:
    """Load and parse a plugin.json file."""
    if not manifest_path.is_file():
        return None
    try:
        with open(manifest_path) as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            return None
        return _parse_manifest(raw, fallback_name)
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Failed to parse manifest %s: %s", manifest_path, exc)
        return None


def _load_hooks_json(hooks_path: Path) -> dict | None:
    """Load hooks/hooks.json."""
    if not hooks_path.is_file():
        return None
    try:
        with open(hooks_path) as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data.get("hooks", data)
        return None
    except (json.JSONDecodeError, OSError):
        return None


def _load_mcp_json(mcp_path: Path) -> dict[str, dict] | None:
    """Load .mcp.json for MCP server configs."""
    if not mcp_path.is_file():
        return None
    try:
        with open(mcp_path) as f:
            data = json.load(f)
        if isinstance(data, dict):
            # .mcp.json can have { "mcpServers": { ... } } or direct { ... }
            return data.get("mcpServers", data)
        return None
    except (json.JSONDecodeError, OSError):
        return None


def create_plugin_from_path(
    plugin_path: Path,
    source: str,
    enabled: bool,
    fallback_name: str,
) -> tuple[LoadedPlugin, list[PluginError]]:
    """Create a LoadedPlugin from a directory.

    Mirrors ``createPluginFromPath`` in pluginLoader.ts:

    1. Look for ``.claude-plugin/plugin.json``, then ``plugin.json``
    2. Parse manifest
    3. Auto-detect ``commands/``, ``agents/``, ``skills/``, ``hooks/``
    4. Load ``hooks/hooks.json`` if present
    5. Load ``.mcp.json`` if present
    6. Validate paths
    """
    errors: list[PluginError] = []
    plugin_path = plugin_path.resolve()
    plugin_str = str(plugin_path)

    # 1. Find manifest
    manifest: PluginManifest | None = None
    for mpath in (
        plugin_path / ".claude-plugin" / "plugin.json",
        plugin_path / "plugin.json",
    ):
        manifest = load_plugin_manifest(mpath, fallback_name)
        if manifest:
            break

    if manifest is None:
        # Minimal manifest from directory name
        manifest = PluginManifest(name=fallback_name)

    # 2. Validate
    validation_errors = validate_manifest(manifest, plugin_str)
    errors.extend(validation_errors)

    # 3. Auto-detect standard directories
    commands_path = None
    agents_path = None
    skills_path = None

    for dirname, attr in (
        ("commands", "commands_path"),
        ("agents", "agents_path"),
        ("skills", "skills_path"),
    ):
        dirpath = plugin_path / dirname
        if dirpath.is_dir():
            if attr == "commands_path":
                commands_path = str(dirpath)
            elif attr == "agents_path":
                agents_path = str(dirpath)
            elif attr == "skills_path":
                skills_path = str(dirpath)

    # Override with manifest-specified paths
    if manifest.commands:
        paths = (manifest.commands,) if isinstance(manifest.commands, str) else manifest.commands
        for p in paths:
            full = plugin_path / p
            if full.is_dir():
                commands_path = str(full)
                break

    if manifest.agents:
        paths = (manifest.agents,) if isinstance(manifest.agents, str) else manifest.agents
        for p in paths:
            full = plugin_path / p
            if full.is_dir():
                agents_path = str(full)
                break

    if manifest.skills:
        paths = (manifest.skills,) if isinstance(manifest.skills, str) else manifest.skills
        for p in paths:
            full = plugin_path / p
            if full.is_dir():
                skills_path = str(full)
                break

    # 4. Load hooks
    hooks_config: dict | None = None
    if isinstance(manifest.hooks, str):
        hooks_config = _load_hooks_json(plugin_path / manifest.hooks)
    elif isinstance(manifest.hooks, dict):
        hooks_config = manifest.hooks
    else:
        # Auto-detect hooks/hooks.json
        hooks_config = _load_hooks_json(plugin_path / "hooks" / "hooks.json")

    # 5. Load MCP config
    mcp_servers = manifest.mcp_servers
    if mcp_servers is None:
        mcp_servers = _load_mcp_json(plugin_path / ".mcp.json")

    plugin = LoadedPlugin(
        name=manifest.name,
        manifest=manifest,
        path=plugin_str,
        source=source,
        enabled=enabled,
        commands_path=commands_path,
        agents_path=agents_path,
        skills_path=skills_path,
        hooks_config=hooks_config,
        mcp_servers=mcp_servers,
        lsp_servers=manifest.lsp_servers,
    )

    return plugin, errors


def load_all_plugins(
    session_plugin_dirs: list[str] | None = None,
) -> PluginLoadResult:
    """Discover and load plugins from all sources.

    Sources:
    1. Builtin plugins (from builtin registry)
    2. Installed/marketplace plugins (from settings)
    3. Session plugins (from session_plugin_dirs)
    """
    from .builtin import get_builtin_plugins
    from .config import load_plugin_settings

    all_enabled: list[LoadedPlugin] = []
    all_disabled: list[LoadedPlugin] = []
    all_errors: list[PluginError] = []

    # 1. Builtin plugins
    settings = load_plugin_settings()
    builtin_enabled, builtin_disabled = get_builtin_plugins(settings)
    all_enabled.extend(builtin_enabled)
    all_disabled.extend(builtin_disabled)

    # 2. Installed plugins
    from .directories import get_installed_plugins_file

    installed_file = get_installed_plugins_file()
    if installed_file.is_file():
        try:
            with open(installed_file) as f:
                installed_data = json.load(f)
            if isinstance(installed_data, dict):
                for plugin_id, info in installed_data.items():
                    if not isinstance(info, dict):
                        continue
                    path = info.get("path", "")
                    if not path or not Path(path).is_dir():
                        continue
                    is_enabled = settings.enabled_plugins.get(plugin_id, True)
                    plugin, errors = create_plugin_from_path(
                        Path(path),
                        source=plugin_id,
                        enabled=is_enabled,
                        fallback_name=plugin_id.split("@")[0],
                    )
                    all_errors.extend(errors)
                    if is_enabled:
                        all_enabled.append(plugin)
                    else:
                        all_disabled.append(plugin)
        except (json.JSONDecodeError, OSError) as exc:
            all_errors.append(
                PluginError(
                    type="generic-error",
                    source=str(installed_file),
                    message=f"Failed to read installed plugins: {exc}",
                )
            )

    # 3. Session plugins
    if session_plugin_dirs:
        for dir_path in session_plugin_dirs:
            if not dir_path or not Path(dir_path).is_dir():
                continue
            plugin_name = Path(dir_path).name
            source = build_plugin_id(plugin_name, "session")
            plugin, errors = create_plugin_from_path(
                Path(dir_path),
                source=source,
                enabled=True,
                fallback_name=plugin_name,
            )
            all_errors.extend(errors)
            all_enabled.append(plugin)

    return PluginLoadResult(
        enabled=tuple(all_enabled),
        disabled=tuple(all_disabled),
        errors=tuple(all_errors),
    )
