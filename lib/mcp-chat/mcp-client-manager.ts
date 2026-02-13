import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type ToolDef = {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
};

type CacheEntry = {
	tools: ToolDef[];
	ts: number;
};

const CACHE_TTL_MS = 30_000;
const toolCache = new Map<string, CacheEntry>();

/**
 * Connect to an external MCP server, list its tools, return their definitions.
 * Results are cached for 30 seconds.
 */
export async function discoverTools(
	serverUrl: string,
	_serverName: string,
): Promise<ToolDef[]> {
	const cached = toolCache.get(serverUrl);
	if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
		return cached.tools;
	}

	const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
	const client = new Client({ name: "mcp-chat-discover", version: "1.0.0" });

	try {
		await client.connect(transport);
		const result = await client.listTools();

		const tools: ToolDef[] = result.tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema as Record<string, unknown>,
		}));

		toolCache.set(serverUrl, { tools, ts: Date.now() });
		return tools;
	} finally {
		await client.close();
	}
}

type McpToolResult = {
	text: string;
	uiHtml: string | null;
	toolName: string;
	serverUrl: string;
};

/**
 * Connect to an external MCP server, call a specific tool, and return the result.
 * Handles UI HTML extraction from resource URIs or inline content.
 */
export async function callExternalMcpTool(
	serverUrl: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<McpToolResult> {
	const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
	const client = new Client({ name: "mcp-chat-exec", version: "1.0.0" });

	try {
		await client.connect(transport);

		const toolResult = await client.callTool({
			name: toolName,
			arguments: args,
		});

		// Try to get UI HTML from tool metadata
		let uiHtml: string | null = null;

		const toolsList = await client.listTools();
		const toolDef = toolsList.tools.find((t) => t.name === toolName);
		const meta = toolDef?._meta as
			| { ui?: { resourceUri?: string } }
			| undefined;
		const resourceUri = meta?.ui?.resourceUri;

		if (resourceUri) {
			try {
				const resourceResult = await client.readResource({ uri: resourceUri });
				const content = resourceResult.contents[0];
				if (content && "text" in content) {
					uiHtml = content.text;
				}
			} catch {
				// Resource read failed — no UI, fall through
			}
		}

		// Also check for inline resource content in the tool result
		if (!uiHtml) {
			const contents = toolResult.content as Array<{
				type: string;
				text?: string;
				resource?: { text?: string; mimeType?: string };
			}>;
			const resourceContent = contents?.find(
				(c) => c.type === "resource" && c.resource?.mimeType === "text/html",
			);
			if (resourceContent?.resource?.text) {
				uiHtml = resourceContent.resource.text;
			}
		}

		// Extract text from tool result
		const textContent =
			(
				toolResult.content as Array<{
					type: string;
					text?: string;
				}>
			)?.find((c) => c.type === "text")?.text ?? "";

		return { text: textContent, uiHtml, toolName, serverUrl };
	} finally {
		await client.close();
	}
}

/**
 * Call a tool on an external MCP server and return the raw result.
 * Used for subsequent interactive calls from iframe UIs (no UI extraction needed).
 */
export async function callExternalMcpToolDirect(
	serverUrl: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text?: string }> }> {
	const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
	const client = new Client({ name: "mcp-chat-direct", version: "1.0.0" });

	try {
		await client.connect(transport);
		const toolResult = await client.callTool({
			name: toolName,
			arguments: args,
		});

		return {
			content:
				(toolResult.content as Array<{ type: string; text?: string }>) ?? [],
		};
	} finally {
		await client.close();
	}
}
