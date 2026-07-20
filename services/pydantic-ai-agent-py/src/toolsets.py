"""Harness capability → durable-tool extraction.

pydantic-ai-harness capabilities (FileSystem, Shell, RepoContext, MCP) are
designed to plug into ``Agent(capabilities=[...])``. This runtime drives its
own Dapr workflow loop instead, so we extract each capability's TOOLSET via
the public ``AbstractCapability.get_toolset()`` seam and route durable
``execute_tool`` activities through it. Capability ``get_instructions()``
contributions are folded into the system prompt.

The router is rebuilt from the (serializable) agentConfig inside each
activity, so a retried activity on a fresh process reconstructs identical
tools deterministically.
"""

from __future__ import annotations

import inspect
import logging
from pathlib import Path
from typing import Any

from pydantic_ai._run_context import RunContext
from pydantic_ai.usage import RunUsage

from src.config import SHELL_TIMEOUT_SECONDS, WORKSPACE_ROOT

logger = logging.getLogger(__name__)


def _run_context() -> RunContext:
    """Minimal RunContext for toolset get_tools/call_tool outside Agent.run."""
    return RunContext(deps=None, model=None, usage=RunUsage())


def build_capabilities(agent_config: dict[str, Any] | None) -> list[Any]:
    """FileSystem + Shell (pod-local, rooted at WORKSPACE_ROOT), RepoContext,
    and MCP capabilities from agentConfig.mcpServers (streamable_http only)."""
    from pydantic_ai_harness import FileSystem, Shell

    cfg = agent_config or {}
    root = Path(WORKSPACE_ROOT)
    root.mkdir(parents=True, exist_ok=True)

    capabilities: list[Any] = [
        FileSystem(root_dir=root),
        Shell(cwd=root, default_timeout=float(SHELL_TIMEOUT_SECONDS)),
    ]

    try:
        from pydantic_ai_harness.context import RepoContext

        capabilities.append(RepoContext(workspace_dir=root))
    except Exception as exc:  # noqa: BLE001
        logger.warning("[toolsets] RepoContext unavailable: %s", exc)

    for server in cfg.get("mcpServers") or []:
        if not isinstance(server, dict):
            continue
        url = server.get("url") or server.get("serverUrl")
        transport = (server.get("transport") or "streamable_http").lower()
        if not url or "http" not in transport:
            logger.warning(
                "[toolsets] skipping MCP server %r (v1 supports streamable_http URLs only)",
                server.get("name") or server.get("server_name"),
            )
            continue
        try:
            from pydantic_ai.capabilities import MCP

            capabilities.append(MCP(url))
        except Exception as exc:  # noqa: BLE001
            logger.warning("[toolsets] MCP capability for %s failed: %s", url, exc)

    return capabilities


class ToolRouter:
    """Name→toolset routing over the capabilities' extracted toolsets."""

    def __init__(self, agent_config: dict[str, Any] | None) -> None:
        self._capabilities = build_capabilities(agent_config)
        self._toolsets: list[Any] = []
        for cap in self._capabilities:
            try:
                toolset = cap.get_toolset()
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[toolsets] %s.get_toolset failed: %s", type(cap).__name__, exc
                )
                continue
            if toolset is not None:
                self._toolsets.append(toolset)

    async def tools(self) -> dict[str, tuple[Any, Any]]:
        """{tool_name: (owning_toolset, ToolsetTool)} across all toolsets."""
        ctx = _run_context()
        combined: dict[str, tuple[Any, Any]] = {}
        for toolset in self._toolsets:
            try:
                tools = await toolset.get_tools(ctx)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[toolsets] get_tools failed on %s: %s", type(toolset).__name__, exc
                )
                continue
            for name, tool in tools.items():
                combined.setdefault(name, (toolset, tool))
        return combined

    async def tool_defs(self) -> list[Any]:
        return [tool.tool_def for _, tool in (await self.tools()).values()]

    async def call(self, name: str, args: dict[str, Any]) -> Any:
        tools = await self.tools()
        if name not in tools:
            raise KeyError(f"unknown tool {name!r}; available: {sorted(tools)}")
        toolset, tool = tools[name]
        return await toolset.call_tool(name, dict(args or {}), _run_context(), tool)

    async def instructions(self) -> str:
        """Concatenated capability instruction contributions (RepoContext etc.)."""
        parts: list[str] = []
        ctx = _run_context()
        for cap in self._capabilities:
            getter = getattr(cap, "get_instructions", None)
            if getter is None:
                continue
            try:
                value = getter(ctx)
                if inspect.isawaitable(value):
                    value = await value
            except Exception as exc:  # noqa: BLE001
                logger.debug(
                    "[toolsets] instructions from %s skipped: %s",
                    type(cap).__name__,
                    exc,
                )
                continue
            if value:
                parts.append(str(value))
        return "\n\n".join(parts).strip()
