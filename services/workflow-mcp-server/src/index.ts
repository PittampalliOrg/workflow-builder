/**
 * Workflow MCP Server
 *
 * MCP server that exposes workflow builder tools over HTTP
 * (StreamableHTTP transport) with an interactive React UI.
 *
 * ENV: DATABASE_URL (required), PORT (default 3200)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { initDb } from "./db.js";
import {
	registerWorkflowTools,
	type RegisteredTool,
} from "./workflow-tools.js";

const PORT = parseInt(process.env.PORT || "3200", 10);
const HOST = process.env.HOST || "0.0.0.0";

// Session-scoped transports
const sessions = new Map<string, StreamableHTTPServerTransport>();

// Loaded at startup
let registeredTools: RegisteredTool[] = [];
let uiHtmlPath: string | undefined;
let hasUI = false;

// ── Helpers ──────────────────────────────────────────────────

function setCorsHeaders(res: http.ServerResponse): void {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "*");
	res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function sendJson(
	res: http.ServerResponse,
	status: number,
	data: unknown,
): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			try {
				const body = Buffer.concat(chunks).toString("utf-8");
				resolve(body ? JSON.parse(body) : undefined);
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

/** Create a new MCP Server instance with workflow tools. */
function createMcpServer(): Server {
	const mcpServer = new McpServer(
		{ name: "workflow-builder-mcp", version: "1.0.0" },
		{ capabilities: { tools: {}, resources: {} } },
	);

	if (hasUI && uiHtmlPath) {
		registerWorkflowTools(mcpServer, uiHtmlPath);
	}

	return mcpServer.server;
}

// ── HTTP Request Handler ─────────────────────────────────────

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	setCorsHeaders(res);

	const url = req.url ?? "/";
	const method = req.method ?? "GET";

	if (method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	if (url === "/health" && method === "GET") {
		sendJson(res, 200, {
			service: "workflow-builder-mcp",
			tools: registeredTools.length,
			toolNames: registeredTools.map((t) => t.name),
			hasUI,
		});
		return;
	}

	if (url === "/mcp") {
		if (method === "POST") {
			await handleMcpPost(req, res);
		} else if (method === "GET") {
			await handleMcpGet(req, res);
		} else if (method === "DELETE") {
			await handleMcpDelete(req, res);
		} else {
			res.writeHead(405);
			res.end("Method Not Allowed");
		}
		return;
	}

	res.writeHead(404);
	res.end("Not Found");
}

async function handleMcpPost(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	let transport: StreamableHTTPServerTransport;

	const body = await parseBody(req);

	if (sessionId && sessions.has(sessionId)) {
		transport = sessions.get(sessionId)!;
	} else if (!sessionId && isInitializeRequest(body)) {
		transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			onsessioninitialized: (sid) => {
				sessions.set(sid, transport);
				console.log(`[wf-mcp] New session: ${sid}`);
			},
		});

		transport.onclose = () => {
			if (transport.sessionId) {
				sessions.delete(transport.sessionId);
				console.log(`[wf-mcp] Session closed: ${transport.sessionId}`);
			}
		};

		const server = createMcpServer();
		await server.connect(transport);
	} else {
		sendJson(res, 400, {
			error: { message: "Bad Request: No valid session ID provided" },
		});
		return;
	}

	await transport.handleRequest(req, res, body);
}

async function handleMcpGet(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	if (!sessionId || !sessions.has(sessionId)) {
		sendJson(res, 404, { error: "Session not found" });
		return;
	}
	const transport = sessions.get(sessionId)!;
	await transport.handleRequest(req, res);
}

async function handleMcpDelete(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	if (!sessionId || !sessions.has(sessionId)) {
		sendJson(res, 404, { error: "Session not found" });
		return;
	}
	const transport = sessions.get(sessionId)!;
	await transport.handleRequest(req, res);
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
	// Initialize database pool
	console.log("[wf-mcp] Initializing database connection...");
	initDb();

	// Check for UI HTML file
	uiHtmlPath = path.join(__dirname, "ui", "workflow-builder", "index.html");
	hasUI = fs.existsSync(uiHtmlPath);
	if (!hasUI) {
		uiHtmlPath = undefined;
		console.warn(
			"[wf-mcp] UI HTML not found — tools will work without interactive UI",
		);
	} else {
		console.log(`[wf-mcp] UI file: ${uiHtmlPath}`);
	}

	// Dry-run registration to count tools
	if (hasUI && uiHtmlPath) {
		const dryServer = new McpServer(
			{ name: "dry-run", version: "0.0.0" },
			{ capabilities: { tools: {}, resources: {} } },
		);
		registeredTools = registerWorkflowTools(dryServer, uiHtmlPath);
	}

	// Start HTTP server
	const httpServer = http.createServer(async (req, res) => {
		try {
			await handleRequest(req, res);
		} catch (error) {
			console.error("[wf-mcp] Unhandled error:", error);
			if (!res.headersSent) {
				sendJson(res, 500, { error: "Internal Server Error" });
			}
		}
	});

	httpServer.listen(PORT, HOST, () => {
		console.log(
			`[wf-mcp] workflow-mcp-server listening on ${HOST}:${PORT}`,
		);
		console.log(
			`[wf-mcp] Registered ${registeredTools.length} tools: ${registeredTools.map((t) => t.name).join(", ")}`,
		);
		console.log(`[wf-mcp] MCP endpoint: http://${HOST}:${PORT}/mcp`);
		console.log(`[wf-mcp] Health check: http://${HOST}:${PORT}/health`);
	});
}

main().catch((error) => {
	console.error("[wf-mcp] Fatal startup error:", error);
	process.exit(1);
});
