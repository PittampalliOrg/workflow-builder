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

// ── Persistent client pool (one session per server URL) ──
type PoolEntry = {
	client: Client;
	lastUsed: number;
};

const clientPool = new Map<string, PoolEntry>();
const POOL_TTL_MS = 5 * 60_000; // 5 minutes idle timeout

// Reap idle pool entries every 60s
setInterval(() => {
	const now = Date.now();
	for (const [url, entry] of clientPool) {
		if (now - entry.lastUsed > POOL_TTL_MS) {
			try {
				entry.client.close();
			} catch {
				/* ignore */
			}
			clientPool.delete(url);
		}
	}
}, 60_000);

async function getPooledClient(serverUrl: string): Promise<Client> {
	const existing = clientPool.get(serverUrl);
	if (existing) {
		existing.lastUsed = Date.now();
		return existing.client;
	}

	const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
	const client = new Client({ name: "mcp-chat-proxy", version: "1.0.0" });
	await client.connect(transport);

	clientPool.set(serverUrl, { client, lastUsed: Date.now() });
	return client;
}

function evictPoolEntry(serverUrl: string) {
	const entry = clientPool.get(serverUrl);
	if (entry) {
		try {
			entry.client.close();
		} catch {
			/* ignore */
		}
		clientPool.delete(serverUrl);
	}
}

/**
 * Connect to an external MCP server, list its tools, return their definitions.
 * Results are cached for 30 seconds. Uses the persistent client pool.
 */
export async function discoverTools(
	serverUrl: string,
	_serverName: string,
): Promise<ToolDef[]> {
	const cached = toolCache.get(serverUrl);
	if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
		return cached.tools;
	}

	const client = await getPooledClient(serverUrl);
	const result = await client.listTools();

	const tools: ToolDef[] = result.tools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema as Record<string, unknown>,
	}));

	toolCache.set(serverUrl, { tools, ts: Date.now() });
	return tools;
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
 * Uses the persistent client pool.
 */
export async function callExternalMcpTool(
	serverUrl: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<McpToolResult> {
	const client = await getPooledClient(serverUrl);

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
}

/**
 * Call a tool on an external MCP server and return the raw result.
 * Used for subsequent interactive calls from iframe UIs (no UI extraction needed).
 * Uses a persistent client pool — one MCP session per server URL.
 */
export async function callExternalMcpToolDirect(
	serverUrl: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text?: string }> }> {
	try {
		const client = await getPooledClient(serverUrl);
		const toolResult = await client.callTool({
			name: toolName,
			arguments: args,
		});

		return {
			content:
				(toolResult.content as Array<{ type: string; text?: string }>) ?? [],
		};
	} catch (err) {
		// Session may have been reaped server-side — evict and retry once
		evictPoolEntry(serverUrl);
		const client = await getPooledClient(serverUrl);
		const toolResult = await client.callTool({
			name: toolName,
			arguments: args,
		});

		return {
			content:
				(toolResult.content as Array<{ type: string; text?: string }>) ?? [],
		};
	}
}
