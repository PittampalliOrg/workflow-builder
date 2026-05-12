"""MCP Resources tools -- list and read MCP server resources."""

from __future__ import annotations


def list_mcp_resources(server: str | None = None) -> str:
    """List available resources from connected MCP servers."""
    # MCP resource listing requires an active MCP client session.
    # The dapr-agents framework manages MCP connections at the agent level.
    # This tool provides the interface -- actual MCP integration depends
    # on whether MCP servers are configured in the agent.
    try:
        return _list_resources_impl(server)
    except Exception as exc:
        return f"Error listing MCP resources: {exc}"


def read_mcp_resource(server: str, uri: str) -> str:
    """Read a specific resource from an MCP server by URI."""
    if not server or not server.strip():
        return "Error: No server name provided."
    if not uri or not uri.strip():
        return "Error: No resource URI provided."

    try:
        return _read_resource_impl(server.strip(), uri.strip())
    except Exception as exc:
        return f"Error reading MCP resource: {exc}"


# ---------------------------------------------------------------------------
# Implementation stubs -- wired up when MCP clients are configured
# ---------------------------------------------------------------------------

_mcp_client_sessions: dict = {}


def register_mcp_session(server_name: str, session: object) -> None:
    """Register an MCP client session for resource access.

    Called during agent initialization when MCP servers are configured.
    """
    _mcp_client_sessions[server_name] = session


def _list_resources_impl(server: str | None) -> str:
    if not _mcp_client_sessions:
        return "No MCP servers configured. Add MCP server connections to the agent to use this tool."

    servers = (
        {server: _mcp_client_sessions[server]}
        if server and server in _mcp_client_sessions
        else _mcp_client_sessions
    )

    if server and server not in _mcp_client_sessions:
        available = ", ".join(sorted(_mcp_client_sessions.keys()))
        return f"Error: MCP server '{server}' not found. Available: {available}"

    lines: list[str] = []
    for name, session in servers.items():
        lines.append(f"Server: {name}")
        try:
            # Attempt to list resources if session supports it
            if hasattr(session, "list_resources"):
                import asyncio

                resources = asyncio.get_event_loop().run_until_complete(
                    session.list_resources()
                )
                for r in getattr(resources, "resources", []):
                    uri = getattr(r, "uri", "N/A")
                    rname = getattr(r, "name", "N/A")
                    desc = getattr(r, "description", "")
                    lines.append(f"  - {rname}: {uri}")
                    if desc:
                        lines.append(f"    {desc}")
            else:
                lines.append("  (session does not support resource listing)")
        except Exception as exc:
            lines.append(f"  Error: {exc}")
        lines.append("")

    return "\n".join(lines) if lines else "No resources found."


def _read_resource_impl(server: str, uri: str) -> str:
    if server not in _mcp_client_sessions:
        available = ", ".join(sorted(_mcp_client_sessions.keys())) if _mcp_client_sessions else "(none)"
        return f"Error: MCP server '{server}' not found. Available: {available}"

    session = _mcp_client_sessions[server]

    if not hasattr(session, "read_resource"):
        return f"Error: MCP server '{server}' session does not support resource reading."

    try:
        import asyncio

        result = asyncio.get_event_loop().run_until_complete(
            session.read_resource(uri)
        )

        # Extract text content from MCP response
        contents = getattr(result, "contents", [])
        parts: list[str] = []
        for content in contents:
            text = getattr(content, "text", None)
            if text:
                parts.append(text)
            else:
                blob = getattr(content, "blob", None)
                if blob:
                    parts.append(f"(binary content, {len(blob)} bytes)")

        return "\n".join(parts) if parts else "Resource returned no content."

    except Exception as exc:
        return f"Error reading resource '{uri}' from '{server}': {exc}"

from .prompt import get_list_mcp_resources_description, get_read_mcp_resource_description
list_mcp_resources.__doc__ = get_list_mcp_resources_description()
read_mcp_resource.__doc__ = get_read_mcp_resource_description()
