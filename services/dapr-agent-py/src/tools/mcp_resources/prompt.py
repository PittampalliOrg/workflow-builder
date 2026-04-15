"""Prompt and constants for the MCP Resources tools.

Ported from claude-code-src/main/tools/ListMcpResourcesTool/prompt.ts
and claude-code-src/main/tools/ReadMcpResourceTool/prompt.ts
"""

LIST_MCP_RESOURCES_TOOL_NAME = "list_mcp_resources"
READ_MCP_RESOURCE_TOOL_NAME = "read_mcp_resource"


def get_list_mcp_resources_description() -> str:
    return """Lists available resources from configured MCP servers.
Each resource object includes a 'server' field indicating which server it's from.

Usage examples:
- List all resources from all servers: list_mcp_resources()
- List resources from a specific server: list_mcp_resources(server="myserver")"""


def get_read_mcp_resource_description() -> str:
    return """Reads a specific resource from an MCP server, identified by server name and resource URI.

Parameters:
- server (required): The name of the MCP server from which to read the resource
- uri (required): The URI of the resource to read

Usage examples:
- Read a resource: read_mcp_resource(server="myserver", uri="my-resource-uri")"""
