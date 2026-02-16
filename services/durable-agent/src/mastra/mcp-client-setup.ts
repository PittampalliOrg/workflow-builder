/**
 * MCP Client Setup — discovers MCP tools from remote servers.
 *
 * Parses MCP_SERVERS env var (JSON array), creates MCPClient from @mastra/mcp,
 * lists tools, and adapts them to DurableAgentTool.
 * Falls back to empty tool set if @mastra/mcp is not installed.
 */

import type { DurableAgentTool } from "../types/tool.js";
import { adaptMastraTools, type MastraToolLike } from "./tool-adapter.js";

export interface McpServerConfig {
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Parse MCP_SERVERS env var into server configs.
 * Expects a JSON array of McpServerConfig objects.
 */
export function parseMcpServersConfig(): McpServerConfig[] {
  const raw = process.env.MCP_SERVERS;
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn("[mcp-client] MCP_SERVERS is not a JSON array, ignoring");
      return [];
    }
    return parsed as McpServerConfig[];
  } catch (err) {
    console.warn(`[mcp-client] Failed to parse MCP_SERVERS: ${err}`);
    return [];
  }
}

/**
 * Discover MCP tools from configured servers.
 *
 * @param configs - Server configs (defaults to parsing MCP_SERVERS env)
 * @returns tools and a disconnect function for cleanup
 */
export async function discoverMcpTools(
  configs?: McpServerConfig[],
): Promise<{
  tools: Record<string, DurableAgentTool>;
  disconnect: () => Promise<void>;
}> {
  const serverConfigs = configs ?? parseMcpServersConfig();
  if (serverConfigs.length === 0) {
    return { tools: {}, disconnect: async () => {} };
  }

  try {
    // @ts-expect-error optional peer dependency
    const mastraMcp = await import("@mastra/mcp");
    const MCPClient = (mastraMcp as any).MCPClient ?? (mastraMcp as any).default?.MCPClient;

    if (!MCPClient) {
      console.warn("[mcp-client] @mastra/mcp loaded but MCPClient class not found");
      return { tools: {}, disconnect: async () => {} };
    }

    // Build server map for MCPClient constructor
    const servers: Record<string, any> = {};
    for (const cfg of serverConfigs) {
      if (cfg.url) {
        servers[cfg.name] = {
          url: new URL(cfg.url),
        };
      } else if (cfg.command) {
        servers[cfg.name] = {
          command: cfg.command,
          args: cfg.args ?? [],
          env: cfg.env ?? {},
        };
      }
    }

    const client = new MCPClient({ servers });

    // Discover tools from all servers
    const rawTools: Record<string, MastraToolLike> = await client.getTools();

    const adapted = adaptMastraTools(rawTools);
    console.log(
      `[mcp-client] Discovered ${Object.keys(adapted).length} MCP tool(s) from ${serverConfigs.length} server(s): ${Object.keys(adapted).join(", ")}`,
    );

    return {
      tools: adapted,
      disconnect: async () => {
        try {
          await client.disconnect();
          console.log("[mcp-client] Disconnected from MCP servers");
        } catch (err) {
          console.warn(`[mcp-client] Disconnect error: ${err}`);
        }
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find module") || msg.includes("MODULE_NOT_FOUND")) {
      console.log("[mcp-client] @mastra/mcp not installed, skipping MCP tools");
    } else {
      console.warn(`[mcp-client] Failed to discover MCP tools: ${msg}`);
    }
    return { tools: {}, disconnect: async () => {} };
  }
}
