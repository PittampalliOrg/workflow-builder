"""Harness capability → durable-tool + hook extraction.

pydantic-ai-harness capabilities are designed to plug into
``Agent(capabilities=[...])``. This runtime drives its own Dapr workflow
loop instead, so we consume capabilities through the seams that map onto
our activities:

- ``get_toolset()``   → tools offered in call_llm, executed in execute_tool
- ``get_instructions()`` → system-prompt bootstrap (call_llm, iteration 0)
- ``before/wrap/after_model_request`` → hosted around ``model.request()``
  INSIDE the call_llm activity (compaction, guards, planning)
- ``after_tool_execute`` → hosted INSIDE the execute_tool activity
  (overflowing tool output)

Run-graph seams (``wrap_run``/node hooks/event streams) have nothing to
attach to here — the Dapr workflow is the run loop (see
docs/pydantic-ai-agent.md).

Routers are cached per (workspace, config-hash) at process level: one pod
serves one session, so capability state (the overflow LocalFileStore,
future Memory backends) stays coherent across activities and retries while
construction remains deterministic from the serializable agentConfig.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable

from pydantic_ai._run_context import RunContext
from pydantic_ai.toolsets import AbstractToolset
from pydantic_ai.usage import RunUsage

from src.compaction.kimi_history import KimiHistoryWindow
from src.compaction.tokens import ContextWindowBudgetError
from src.config import (
    COMPACTION_ENABLED,
    MCP_CALL_TIMEOUT_SECONDS,
    MCP_FAIL_CACHE_SECONDS,
    MCP_LIST_TIMEOUT_SECONDS,
    MCP_READ_TIMEOUT_SECONDS,
    MCP_TOOLS_CACHE_SECONDS,
    OVERFLOW_ENABLED,
    REPO_INVENTORY_TOOL_ENABLED,
    SHELL_DENIED_ENV_PATTERNS,
    SHELL_TIMEOUT_SECONDS,
    WORKSPACE_ROOT,
)

logger = logging.getLogger(__name__)

_TOOL_NAME_ALIASES = {
    "execute_command": "run_command",
    "list_files": "list_directory",
    "glob_files": "find_files",
    "grep_search": "search_files",
}


@dataclass(frozen=True)
class _McpCapabilityBinding:
    capability: Any
    allowed_tools: set[str] | None
    capability_factory: Callable[[], Any] | None = None

    def get_toolset(self) -> Any:
        return self.capability.get_toolset()

    def fresh_toolset(self) -> Any:
        if self.capability_factory is None:
            return None
        return self.capability_factory().get_toolset()


def _normalize_tool_names(value: Any) -> set[str]:
    if not isinstance(value, list):
        return set()
    names = {
        str(item).strip()
        for item in value
        if isinstance(item, str) and str(item).strip()
    }
    return names | {
        alias
        for configured_name in names
        if (alias := _TOOL_NAME_ALIASES.get(configured_name)) is not None
    }


def _runtime_tool_ceiling(
    agent_config: dict[str, Any] | None,
) -> set[str] | None:
    """Return the explicit runtime-wide ceiling, preserving an empty list."""
    config = agent_config or {}
    if "allowedTools" not in config:
        return None
    return _normalize_tool_names(config.get("allowedTools"))


def _configured_local_tool_allowlist(
    agent_config: dict[str, Any] | None,
) -> set[str] | None:
    """Return the saved local-tool selection without constraining MCP tools."""
    config = agent_config or {}

    configured = False
    names: set[str] = set()
    for key in ("tools", "builtinTools"):
        if key not in config:
            continue
        configured = True
        value = config.get(key)
        if not isinstance(value, list):
            return set()
        names.update(_normalize_tool_names(value))
    if not configured:
        return None
    return names


def _mcp_tool_allowlist(server: dict[str, Any]) -> set[str] | None:
    for key in ("allowedTools", "allowed_tools"):
        if key not in server:
            continue
        value = server.get(key)
        if not isinstance(value, list):
            return set()
        return {
            str(item).strip()
            for item in value
            if isinstance(item, str) and str(item).strip()
        }
    return None


def _run_context(messages: list[Any] | None = None, model: Any = None) -> RunContext:
    """Minimal RunContext for capability seams outside Agent.run."""
    ctx = RunContext(deps=None, model=model, usage=RunUsage())
    if messages is not None:
        try:
            ctx = RunContext(
                deps=None, model=model, usage=RunUsage(), messages=messages
            )
        except TypeError:
            pass
    return ctx


def build_capabilities(
    agent_config: dict[str, Any] | None,
    *,
    workspace_dir: Path | None = None,
) -> list[Any]:
    """Tool + hook capabilities, in application order.

    Order matters for the model-request hook chain: KimiHistoryWindow bounds
    whole replay-safe message groups before the request reaches K3. List order
    stands in for upstream's ``get_ordering`` sort (documented simplification).
    """
    from pydantic_ai_harness import FileSystem, Shell

    cfg = agent_config or {}

    from src.composition import workspace_scope_port

    workspace_scope = workspace_scope_port(WORKSPACE_ROOT)
    workspace_root = workspace_scope.resolve()
    requested_workspace = (
        str(workspace_dir) if workspace_dir is not None else cfg.get("cwd")
    )
    root = workspace_scope.resolve(requested_workspace)

    # Shell receives the selected starting directory. The pod sandbox remains
    # the filesystem security boundary for commands and absolute paths.
    capabilities: list[Any] = [
        FileSystem(root_dir=root),
        # denied_env_patterns scrubs credential names from the shell
        # subprocess's inherited env (KIMI_API_KEY, provider keys, internal
        # token, …) so an agent command can't exfiltrate the pod's secrets.
        # Background-process tools (start/check/stop_command) come with Shell.
        Shell(
            cwd=root,
            default_timeout=float(SHELL_TIMEOUT_SECONDS),
            denied_env_patterns=SHELL_DENIED_ENV_PATTERNS,
        ),
    ]

    from src.composition import workspace_image_port
    from src.media_tools import build_media_toolset

    capabilities.append(build_media_toolset(workspace_image_port(str(root))))

    try:
        from pydantic_ai_harness.context import RepoContext

        # expose_inventory_tool default-off: the harness pairs the tool with a
        # system-prompt hint ("map the repo's coding-assistant setup ... so you
        # can read and translate it") that Kimi treats as a STANDING MISSION —
        # observed burning entire turns scaffolding/"translating" config dirs
        # instead of the actual task (and one wasted tool call in every run).
        # Walk-up CLAUDE.md/AGENTS.md autoload (the valuable part) stays on.
        capabilities.append(
            RepoContext(
                workspace_dir=root,
                expose_inventory_tool=REPO_INVENTORY_TOOL_ENABLED,
            )
        )
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
        # Per-server HTTP headers carry the AUTHORIZATION context the endpoint
        # needs — critically the `X-Wfb-Team-*` role assertion that
        # workflow-mcp-server requires before it exposes the team tools
        # (claim_task/update_task/…). Dropping them silently downgrades the
        # server to non-team scope, so a teammate never sees update_task and
        # can only NARRATE completion (observed: team turns never converge).
        # AP piece servers likewise need their connection/auth headers.
        raw_headers = server.get("headers")
        headers = (
            {str(k): str(v) for k, v in raw_headers.items()}
            if isinstance(raw_headers, dict) and raw_headers
            else None
        )
        auth_token = server.get("authorizationToken") or server.get(
            "authorization_token"
        )
        try:
            from pydantic_ai.capabilities import MCP
            from pydantic_ai.mcp import MCPToolset

            normalized_token = (
                auth_token.strip()
                if isinstance(auth_token, str) and auth_token.strip()
                else None
            )

            def capability_factory(
                *,
                server_url: str = str(url),
                server_headers: dict[str, str] | None = headers,
                authorization_token: str | None = normalized_token,
            ) -> Any:
                local_headers = dict(server_headers or {})
                if authorization_token:
                    local_headers["Authorization"] = authorization_token
                # Keep the FastMCP read deadline just inside the outer
                # durable-activity guard. Its 300s default can otherwise
                # preempt server-owned operations such as browser capture
                # finalization, which is intentionally bounded at 420s.
                local = MCPToolset(
                    server_url,
                    headers=local_headers or None,
                    include_instructions=True,
                    read_timeout=float(MCP_READ_TIMEOUT_SECONDS),
                )
                return MCP(
                    server_url,
                    local=local,
                    headers=server_headers,
                    authorization_token=authorization_token,
                )

            capability = capability_factory()
            capabilities.append(
                _McpCapabilityBinding(
                    capability=capability,
                    allowed_tools=_mcp_tool_allowlist(server),
                    capability_factory=capability_factory,
                )
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[toolsets] MCP capability for %s failed: %s", url, exc)

    if OVERFLOW_ENABLED:
        try:
            from pydantic_ai_harness.overflowing_tool_output import (
                LocalFileStore,
                OverflowingToolOutput,
            )

            # File-backed spill under the workspace: survives process
            # restarts and is readable by read_tool_result from any later
            # activity on this pod.
            capabilities.append(
                OverflowingToolOutput(
                    store=LocalFileStore(base_dir=workspace_root / ".overflow")
                )
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[toolsets] OverflowingToolOutput unavailable: %s", exc)

    if COMPACTION_ENABLED:
        try:
            capabilities.append(KimiHistoryWindow())
        except Exception as exc:  # noqa: BLE001
            logger.warning("[toolsets] compaction capabilities unavailable: %s", exc)

    return capabilities


class ToolRouter:
    """Name→toolset routing + hook-chain application over the capabilities."""

    def __init__(
        self,
        agent_config: dict[str, Any] | None,
        *,
        workspace_dir: Path | None = None,
    ) -> None:
        self._capabilities = build_capabilities(
            agent_config, workspace_dir=workspace_dir
        )
        self._runtime_tool_ceiling = _runtime_tool_ceiling(agent_config)
        self._local_tool_allowlist = _configured_local_tool_allowlist(agent_config)
        self._toolsets: list[Any] = []
        # Toolsets whose get_tools/call_tool cross the network (MCP): guard
        # them with a timeout so a stalled streamable-HTTP session (no
        # per-call timeout upstream) can never wedge a durable activity.
        self._network_toolsets: set[int] = set()
        self._toolset_allowlists: dict[int, set[str] | None] = {}
        self._network_toolset_factories: dict[int, Callable[[], Any]] = {}
        # Execution routes captured when tools are advertised to the model.
        # Activities use these bindings directly: route lookup must not re-list
        # unrelated MCP servers, especially after a long reasoning turn lets a
        # discovery cache expire.
        self._tool_routes: dict[str, tuple[Any, Any]] = {}
        # Harness support tools are implementation infrastructure. In
        # particular, read_tool_result must remain available whenever overflow
        # is enabled or the model can receive a spill pointer it cannot follow.
        self._support_toolsets: set[int] = set()
        # Per-toolset MCP LISTING caches. Every durable activity re-enters the
        # router, and re-listing every MCP server per activity is O(servers ×
        # activities) network handshakes — with several wired servers (auto
        # project connections) and one cold/broken endpoint this taxed each
        # activity 30-45s and starved team turns. Listings are stable within a
        # session, so cache successes for MCP_TOOLS_CACHE_SECONDS and
        # NEGATIVE-cache failing servers for MCP_FAIL_CACHE_SECONDS (skip
        # without re-probing). Tool CALLS still connect fresh per call.
        self._mcp_tools_cache: dict[int, tuple[float, dict[str, Any]]] = {}
        self._mcp_fail_until: dict[int, float] = {}
        for cap in self._capabilities:
            is_mcp = isinstance(cap, _McpCapabilityBinding) or (
                type(cap).__name__ == "MCP" or "mcp" in type(cap).__module__.lower()
            )
            is_support = type(cap).__name__ == "OverflowingToolOutput"
            if isinstance(cap, AbstractToolset):
                toolset = cap
            else:
                try:
                    toolset = cap.get_toolset()
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "[toolsets] %s.get_toolset failed: %s", type(cap).__name__, exc
                    )
                    continue
            if toolset is not None:
                self._toolsets.append(toolset)
                if is_support:
                    self._support_toolsets.add(id(toolset))
                if is_mcp:
                    self._network_toolsets.add(id(toolset))
                    self._toolset_allowlists[id(toolset)] = (
                        cap.allowed_tools
                        if isinstance(cap, _McpCapabilityBinding)
                        else None
                    )
                    if (
                        isinstance(cap, _McpCapabilityBinding)
                        and cap.capability_factory is not None
                    ):
                        self._network_toolset_factories[id(toolset)] = cap.fresh_toolset

    # ------------------------------------------------------------------
    # Tool routing
    # ------------------------------------------------------------------

    async def _get_tools(self, toolset: Any, ctx: Any) -> dict[str, Any]:
        """get_tools on one toolset, timeout-guarded for network toolsets."""
        coro = toolset.get_tools(ctx)
        if id(toolset) in self._network_toolsets:
            return await asyncio.wait_for(coro, timeout=MCP_LIST_TIMEOUT_SECONDS)
        return await coro

    def _tool_allowed(self, toolset: Any, name: str) -> bool:
        toolset_id = id(toolset)
        if toolset_id in self._support_toolsets:
            return True
        if (
            self._runtime_tool_ceiling is not None
            and name not in self._runtime_tool_ceiling
        ):
            return False
        if (
            toolset_id not in self._network_toolsets
            and self._local_tool_allowlist is not None
            and name not in self._local_tool_allowlist
        ):
            return False
        server_allowlist = self._toolset_allowlists.get(toolset_id)
        return server_allowlist is None or name in server_allowlist

    def _register_tool(
        self,
        combined: dict[str, tuple[Any, Any]],
        name: str,
        toolset: Any,
        tool: Any,
    ) -> None:
        binding = (toolset, tool)
        if id(toolset) in self._support_toolsets:
            combined[name] = binding
        else:
            combined.setdefault(name, binding)

    async def tools(self) -> dict[str, tuple[Any, Any]]:
        ctx = _run_context()
        now = time.monotonic()
        combined: dict[str, tuple[Any, Any]] = {}
        for toolset in self._toolsets:
            is_network = id(toolset) in self._network_toolsets
            if is_network:
                cached = self._mcp_tools_cache.get(id(toolset))
                if cached and cached[0] > now:
                    for name, tool in cached[1].items():
                        if self._tool_allowed(toolset, name):
                            self._register_tool(combined, name, toolset, tool)
                    continue
                fail_until = self._mcp_fail_until.get(id(toolset), 0.0)
                if fail_until > now:
                    continue  # negative-cached failing server; skip re-probe
            try:
                tools = await self._get_tools(toolset, ctx)
            except asyncio.TimeoutError:
                logger.warning(
                    "[toolsets] %s.get_tools timed out after %ss — MCP tools "
                    "unavailable (skipping this server for %ss)",
                    type(toolset).__name__,
                    MCP_LIST_TIMEOUT_SECONDS,
                    MCP_FAIL_CACHE_SECONDS,
                )
                replacement = (
                    self._replace_network_toolset(toolset) if is_network else None
                )
                if is_network:
                    failed_id = (
                        id(replacement) if replacement is not None else id(toolset)
                    )
                    self._mcp_fail_until[failed_id] = now + MCP_FAIL_CACHE_SECONDS
                continue
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[toolsets] get_tools failed on %s: %s (skipping for %ss)",
                    type(toolset).__name__,
                    exc,
                    MCP_FAIL_CACHE_SECONDS,
                )
                disconnected = "client is not connected" in str(exc).lower()
                replacement = (
                    self._replace_network_toolset(toolset)
                    if is_network and disconnected
                    else None
                )
                if is_network:
                    failed_id = (
                        id(replacement) if replacement is not None else id(toolset)
                    )
                    self._mcp_fail_until[failed_id] = now + MCP_FAIL_CACHE_SECONDS
                continue
            if is_network:
                self._mcp_tools_cache[id(toolset)] = (
                    now + MCP_TOOLS_CACHE_SECONDS,
                    dict(tools),
                )
                self._mcp_fail_until.pop(id(toolset), None)
            for name, tool in tools.items():
                if self._tool_allowed(toolset, name):
                    self._register_tool(combined, name, toolset, tool)
        # This advertisement is authoritative for the next model response.
        # Replace, rather than extend, execution routes so removed MCP tools
        # cannot survive a refreshed listing as stale non-sequential routes.
        self._tool_routes = dict(combined)
        return combined

    async def tool_defs_with_execution(self) -> tuple[list[Any], set[str]]:
        """Return definitions and tools that require ordered execution.

        MCP clients carry transport-session state and cannot be shared safely
        by the separate event loops used by concurrent durable activities.
        The workflow uses the returned names as barriers while leaving local
        tools eligible for parallel fan-out.
        """
        tools = await self.tools()
        definitions = []
        sequential = set()
        for name, (toolset, tool) in tools.items():
            tool_def = tool.tool_def
            is_network = id(toolset) in self._network_toolsets
            if is_network and not tool_def.sequential:
                tool_def = replace(tool_def, sequential=True)
            if is_network or tool_def.sequential:
                sequential.add(name)
            definitions.append(tool_def)
        return definitions, sequential

    async def tool_defs(self) -> list[Any]:
        definitions, _ = await self.tool_defs_with_execution()
        return definitions

    def _replace_network_toolset(self, toolset: Any) -> Any | None:
        """Replace one unusable MCP client without disturbing other servers."""
        toolset_id = id(toolset)
        factory = self._network_toolset_factories.get(toolset_id)
        if factory is None:
            return None
        try:
            replacement = factory()
            index = next(
                index
                for index, candidate in enumerate(self._toolsets)
                if candidate is toolset
            )
        except (Exception, StopIteration) as exc:  # noqa: BLE001
            logger.warning(
                "[toolsets] failed to rebuild disconnected MCP toolset: %s", exc
            )
            return None
        if replacement is None:
            return None

        allowlist = self._toolset_allowlists.pop(toolset_id, None)
        self._toolsets[index] = replacement
        self._network_toolsets.discard(toolset_id)
        self._network_toolsets.add(id(replacement))
        self._toolset_allowlists[id(replacement)] = allowlist
        self._network_toolset_factories.pop(toolset_id, None)
        self._network_toolset_factories[id(replacement)] = factory
        self._mcp_tools_cache.pop(toolset_id, None)
        self._mcp_fail_until.pop(toolset_id, None)
        self._tool_routes = {
            name: binding
            for name, binding in self._tool_routes.items()
            if binding[0] is not toolset
        }
        return replacement

    async def _resolve_tool(self, name: str) -> tuple[Any, Any] | None:
        """Resolve one execution route without global MCP discovery when known."""
        cached_route = self._tool_routes.get(name)
        if cached_route is not None:
            return cached_route

        # A fresh process may reconstruct the router between call_llm and the
        # durable tool activity. Resolve local capabilities first and never
        # involve network toolsets for a known local name.
        local_matches: dict[str, tuple[Any, Any]] = {}
        ctx = _run_context()
        for toolset in self._toolsets:
            if id(toolset) in self._network_toolsets:
                continue
            try:
                local_tools = await self._get_tools(toolset, ctx)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[toolsets] local get_tools failed on %s: %s",
                    type(toolset).__name__,
                    exc,
                )
                continue
            tool = local_tools.get(name)
            if tool is not None and self._tool_allowed(toolset, name):
                self._register_tool(local_matches, name, toolset, tool)
        local_route = local_matches.get(name)
        if local_route is not None:
            self._tool_routes[name] = local_route
            return local_route

        # An expired listing is still the route that was advertised to the
        # model. It is valid for executing that emitted call and avoids a new
        # global handshake solely because the TTL elapsed during reasoning.
        for toolset in self._toolsets:
            if id(toolset) not in self._network_toolsets:
                continue
            cached_listing = self._mcp_tools_cache.get(id(toolset))
            if cached_listing is None:
                continue
            tool = cached_listing[1].get(name)
            if tool is not None and self._tool_allowed(toolset, name):
                route = (toolset, tool)
                self._tool_routes[name] = route
                return route

        # Unknown network tools after process reconstruction require a fresh
        # advertisement pass. This is the exceptional fallback, not the normal
        # execute_tool path.
        return (await self.tools()).get(name)

    async def call(self, name: str, args: dict[str, Any]) -> Any:
        route = await self._resolve_tool(name)
        if route is None:
            raise KeyError(
                f"unknown tool {name!r}; available: {sorted(self._tool_routes)}"
            )
        toolset, tool = route
        coro = toolset.call_tool(name, dict(args or {}), _run_context(), tool)
        # Timeout-guard network (MCP) tool calls; local FS/Shell tools run
        # unbounded (Shell has its own per-command timeout).
        if id(toolset) in self._network_toolsets:
            try:
                return await asyncio.wait_for(coro, timeout=MCP_CALL_TIMEOUT_SECONDS)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                # wait_for cancels the in-flight FastMCP context. A cancelled
                # client's transport can remain disconnected after unwinding,
                # so the next durable retry needs a fresh client for only this
                # server binding.
                self._replace_network_toolset(toolset)
                raise
            except Exception as exc:
                if "client is not connected" in str(exc).lower():
                    self._replace_network_toolset(toolset)
                raise
        return await coro

    async def instructions(self) -> str:
        parts: list[str] = []
        ctx = _run_context()
        for cap in self._capabilities:
            getter = getattr(cap, "get_instructions", None)
            if getter is None:
                continue
            try:
                value = getter()
                if callable(value):
                    value = value(ctx)
                if inspect.isawaitable(value):
                    value = await value
            except TypeError:
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

    # ------------------------------------------------------------------
    # Hook chains (hosted inside the durable activities)
    # ------------------------------------------------------------------

    async def _maybe_await(self, value: Any) -> Any:
        if inspect.isawaitable(value):
            return await value
        return value

    async def apply_before_model_request(self, request_context: Any) -> Any:
        """Chain each capability's before_model_request over the request
        context (compaction lives here). Fail-soft per capability."""
        ctx = _run_context(
            messages=request_context.messages, model=request_context.model
        )
        for cap in self._capabilities:
            hook = getattr(cap, "before_model_request", None)
            if hook is None:
                continue
            try:
                result = await self._maybe_await(hook(ctx, request_context))
                if result is not None:
                    request_context = result
            except ContextWindowBudgetError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[hooks] before_model_request %s failed (skipped): %s",
                    type(cap).__name__,
                    exc,
                )
        return request_context

    async def apply_model_request(self, request_context: Any, base_handler) -> Any:
        """Fold wrap_model_request chain around the base model call."""
        ctx = _run_context(
            messages=request_context.messages, model=request_context.model
        )
        handler = base_handler
        for cap in reversed(self._capabilities):
            wrap = getattr(cap, "wrap_model_request", None)
            if wrap is None:
                continue
            inner = handler

            def make_handler(cap=cap, wrap=wrap, inner=inner):
                async def wrapped(rc):
                    return await self._maybe_await(
                        wrap(ctx, request_context=rc, handler=inner)
                    )

                return wrapped

            handler = make_handler()
        return await handler(request_context)

    async def apply_after_model_request(
        self, request_context: Any, response: Any
    ) -> Any:
        ctx = _run_context(
            messages=request_context.messages, model=request_context.model
        )
        for cap in self._capabilities:
            hook = getattr(cap, "after_model_request", None)
            if hook is None:
                continue
            try:
                result = await self._maybe_await(
                    hook(ctx, request_context=request_context, response=response)
                )
                if result is not None:
                    response = result
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[hooks] after_model_request %s failed (skipped): %s",
                    type(cap).__name__,
                    exc,
                )
        return response

    async def apply_after_tool_execute(
        self, *, call: Any, tool_def: Any, args: dict[str, Any], result: Any
    ) -> Any:
        """Chain after_tool_execute (overflow spill/truncate lives here)."""
        ctx = _run_context()
        for cap in self._capabilities:
            hook = getattr(cap, "after_tool_execute", None)
            if hook is None:
                continue
            try:
                transformed = await self._maybe_await(
                    hook(ctx, call=call, tool_def=tool_def, args=args, result=result)
                )
                if transformed is not None:
                    result = transformed
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[hooks] after_tool_execute %s failed (skipped): %s",
                    type(cap).__name__,
                    exc,
                )
        return result


# ---------------------------------------------------------------------------
# Process-level router cache (one pod == one session)
# ---------------------------------------------------------------------------

_ROUTERS: dict[str, ToolRouter] = {}


def _config_key(
    agent_config: dict[str, Any] | None,
    *,
    workspace_root: Path,
    workspace_dir: Path,
) -> str:
    config = agent_config or {}
    relevant = {
        "workspaceRoot": str(workspace_root),
        "cwd": str(workspace_dir),
        "mcpServers": config.get("mcpServers") or [],
        # Session control events can narrow tools between turns. Preserve
        # presence and empty lists so a router built under an older ceiling is
        # never reused after a hot policy update.
        "toolPolicy": {
            key: config[key]
            for key in ("tools", "allowedTools", "builtinTools")
            if key in config
        },
    }
    return hashlib.sha256(
        json.dumps(relevant, sort_keys=True, default=str).encode()
    ).hexdigest()[:16]


def get_router(agent_config: dict[str, Any] | None) -> ToolRouter:
    """Cached ToolRouter so capability state (overflow store, future memory)
    is shared across activities on this pod. Construction stays deterministic
    from the serializable agentConfig, so a fresh process rebuilds an
    equivalent router on retry."""
    from src.composition import workspace_scope_port

    config = agent_config or {}
    workspace_scope = workspace_scope_port(WORKSPACE_ROOT)
    workspace_root = workspace_scope.resolve()
    workspace_dir = workspace_scope.resolve(config.get("cwd"))
    key = _config_key(
        config,
        workspace_root=workspace_root,
        workspace_dir=workspace_dir,
    )
    router = _ROUTERS.get(key)
    if router is None:
        router = ToolRouter(config, workspace_dir=workspace_dir)
        _ROUTERS[key] = router
    return router
