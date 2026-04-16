"""Pydantic models for plugin.json.

Field aliases match the TS PluginManifest shape so a TS-authored
plugin.json parses byte-for-byte. Unknown top-level fields are ignored
(`extra="ignore"`) — we parse what we understand and skip the rest.
"""
from __future__ import annotations

from typing import Any, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

from ..hooks.schemas import HooksSettings


_BaseConfig = ConfigDict(populate_by_name=True, extra="ignore")


class PluginAuthor(BaseModel):
    model_config = _BaseConfig
    name: str = ""
    email: Optional[str] = None
    url: Optional[str] = None


class PluginUserConfigOption(BaseModel):
    model_config = _BaseConfig
    type: str = "string"
    description: Optional[str] = None
    required: Optional[bool] = None
    default: Any = None
    sensitive: Optional[bool] = None
    enum: Optional[list[Any]] = None


class PluginDependencyRef(BaseModel):
    model_config = _BaseConfig
    name: str
    marketplace: Optional[str] = None
    version: Optional[str] = None


class PluginMcpServerEntry(BaseModel):
    """Single inline MCP server entry inside manifest `mcpServers`.

    Kept loose — the agent's existing `_extract_mcp_server_configs` path
    in src/main.py does richer validation. We only store enough to
    recognize, substitute ${CLAUDE_PLUGIN_*}, and hand off.
    """

    model_config = _BaseConfig
    server_name: Optional[str] = Field(default=None, alias="serverName")
    name: Optional[str] = None
    transport: Optional[str] = None
    type: Optional[str] = None
    url: Optional[str] = None
    command: Optional[str] = None
    args: Optional[list[Any]] = None
    env: Optional[dict[str, Any]] = None
    headers: Optional[dict[str, Any]] = None
    cwd: Optional[str] = None
    allowed_tools: Optional[list[str]] = Field(default=None, alias="allowedTools")


class PluginManifestMetadata(BaseModel):
    model_config = _BaseConfig
    name: str
    version: Optional[str] = "0.1.0"
    description: Optional[str] = None
    author: Optional[Union[str, PluginAuthor]] = None
    homepage: Optional[str] = None
    repository: Optional[str] = None
    license: Optional[str] = None
    keywords: Optional[list[str]] = None
    dependencies: Optional[list[Union[str, PluginDependencyRef]]] = None


class PluginManifest(BaseModel):
    """Top-level plugin.json schema.

    Notes on the sprawling `hooks` / `mcpServers` field shapes:
      - Values can be: string path, inline object, or an array of either
      - Resolution happens in loader.py after the manifest is parsed
      - Here we accept the raw typed-ish shapes and let the loader walk them
    """

    model_config = _BaseConfig

    name: str
    version: Optional[str] = "0.1.0"
    description: Optional[str] = None
    author: Optional[Union[str, PluginAuthor]] = None
    homepage: Optional[str] = None
    repository: Optional[str] = None
    license: Optional[str] = None
    keywords: Optional[list[str]] = None
    dependencies: Optional[list[Union[str, PluginDependencyRef]]] = None

    # These are raw until loader.resolve_*() walks them.
    hooks: Any = None
    mcp_servers: Any = Field(default=None, alias="mcpServers")

    # v1 parses but ignores the rest.
    commands: Any = None
    agents: Any = None
    skills: Any = None
    output_styles: Any = Field(default=None, alias="outputStyles")
    lsp_servers: Any = Field(default=None, alias="lspServers")
    channels: Any = None
    settings: Any = None
    user_config: Optional[dict[str, PluginUserConfigOption]] = Field(default=None, alias="userConfig")


__all__ = [
    "PluginAuthor",
    "PluginUserConfigOption",
    "PluginDependencyRef",
    "PluginMcpServerEntry",
    "PluginManifestMetadata",
    "PluginManifest",
]
