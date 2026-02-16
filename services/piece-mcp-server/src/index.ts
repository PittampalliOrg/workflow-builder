/**
 * Piece MCP Server
 *
 * Parameterized MCP server that exposes all actions of a single
 * Activepieces piece as MCP tools over HTTP (StreamableHTTP transport).
 *
 * ENV: PIECE_NAME (required), DATABASE_URL (required), PORT (default 3100)
 */

import "./otel.js";

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";
import { getPiece, normalizePieceName } from "./piece-registry.js";
import {
	registerPieceTools,
	registerPieceToolsWithUI,
	type PieceMetadataRow,
	type RegisteredTool,
} from "./piece-to-mcp.js";
import type { Piece } from "@activepieces/pieces-framework";

const PORT = parseInt(process.env.PORT || "3100", 10);
const HOST = process.env.HOST || "0.0.0.0";

// Session-scoped transports
const sessions = new Map<string, StreamableHTTPServerTransport>();

// Loaded at startup
let piece: Piece;
let metadata: PieceMetadataRow;
let pieceName: string;
let registeredTools: RegisteredTool[] = [];
let hasUI = false;
let uiHtmlPath: string | undefined;

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

/** Create a new MCP Server instance with all piece tools registered. */
function createMcpServer(): Server {
	if (hasUI && uiHtmlPath) {
		const mcpServer = new McpServer(
			{ name: `piece-${pieceName}`, version: "1.0.0" },
			{ capabilities: { tools: {}, resources: {} } },
		);
		registerPieceToolsWithUI(
			mcpServer,
			piece,
			metadata,
			uiHtmlPath,
			normalizePieceName(pieceName),
		);
		return mcpServer.server; // Return underlying Server for transport
	}

	const server = new Server(
		{
			name: `piece-${pieceName}`,
			version: "1.0.0",
		},
		{
			capabilities: { tools: {} },
		},
	);

	registerPieceTools(server, piece, metadata);
	return server;
}

// ── Fetch piece metadata from DB ─────────────────────────────

async function fetchPieceMetadata(name: string): Promise<PieceMetadataRow> {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required");
	}

	const normalizedName = normalizePieceName(name);
	const client = new pg.Client(databaseUrl);
	await client.connect();

	try {
		const result = await client.query<{
			actions: Record<string, unknown> | null;
			auth: unknown;
			display_name: string | null;
		}>(
			`SELECT actions, auth, display_name FROM piece_metadata
			 WHERE name = $1 ORDER BY created_at DESC LIMIT 1`,
			[normalizedName],
		);

		if (result.rows.length === 0) {
			throw new Error(
				`No metadata found for piece "${name}" in piece_metadata table. ` +
					"Run: npx tsx scripts/sync-activepieces-pieces.ts",
			);
		}

		const row = result.rows[0];
		return {
			actions: row.actions as PieceMetadataRow["actions"],
			auth: row.auth,
			displayName: row.display_name,
		};
	} finally {
		await client.end();
	}
}

// ── HTTP Request Handler ─────────────────────────────────────

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	setCorsHeaders(res);

	const url = req.url ?? "/";
	const method = req.method ?? "GET";

	// CORS preflight
	if (method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	// Health check
	if (url === "/health" && method === "GET") {
		sendJson(res, 200, {
			piece: pieceName,
			tools: registeredTools.length,
			toolNames: registeredTools.map((t) => t.name),
			hasUI,
		});
		return;
	}

	// MCP routes
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
		// Existing session
		transport = sessions.get(sessionId)!;
	} else if (!sessionId && isInitializeRequest(body)) {
		// New session
		transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			onsessioninitialized: (sid) => {
				sessions.set(sid, transport);
				console.log(`[piece-mcp] New session: ${sid}`);
			},
		});

		transport.onclose = () => {
			if (transport.sessionId) {
				sessions.delete(transport.sessionId);
				console.log(`[piece-mcp] Session closed: ${transport.sessionId}`);
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
	pieceName = process.env.PIECE_NAME ?? "";
	if (!pieceName) {
		console.error("PIECE_NAME env var is required");
		process.exit(1);
	}

	// Load piece from registry
	const loadedPiece = getPiece(pieceName);
	if (!loadedPiece) {
		console.error(
			`Piece "${pieceName}" not found in registry. Available: ${(await import("./piece-registry.js")).listPieceNames().join(", ")}`,
		);
		process.exit(1);
	}
	piece = loadedPiece;

	// Fetch metadata from DB
	console.log(`[piece-mcp] Loading metadata for piece "${pieceName}"...`);
	metadata = await fetchPieceMetadata(pieceName);
	console.log(
		`[piece-mcp] Loaded metadata: ${metadata.displayName ?? pieceName}`,
	);

	// Check for UI HTML file (Vite outputs to dist/ui/{name}/index.html)
	const normalizedName = normalizePieceName(pieceName);
	uiHtmlPath = path.join(__dirname, "ui", normalizedName, "index.html");
	hasUI = fs.existsSync(uiHtmlPath);
	if (!hasUI) {
		// Fallback: check for flat file (dist/ui/{name}.html)
		uiHtmlPath = path.join(__dirname, "ui", `${normalizedName}.html`);
		hasUI = fs.existsSync(uiHtmlPath);
	}
	if (!hasUI) {
		uiHtmlPath = undefined;
	}
	console.log(`[piece-mcp] UI file: ${hasUI ? uiHtmlPath : "not found"}`);

	// Do a dry-run registration to count tools for startup log
	if (hasUI && uiHtmlPath) {
		const dryMcpServer = new McpServer(
			{ name: "dry-run", version: "0.0.0" },
			{ capabilities: { tools: {}, resources: {} } },
		);
		registeredTools = registerPieceToolsWithUI(
			dryMcpServer,
			piece,
			metadata,
			uiHtmlPath,
			normalizedName,
		);
	} else {
		const dryServer = new Server(
			{ name: "dry-run", version: "0.0.0" },
			{ capabilities: { tools: {} } },
		);
		registeredTools = registerPieceTools(dryServer, piece, metadata);
	}

	// Start HTTP server
	const httpServer = http.createServer(async (req, res) => {
		try {
			await handleRequest(req, res);
		} catch (error) {
			console.error("[piece-mcp] Unhandled error:", error);
			if (!res.headersSent) {
				sendJson(res, 500, { error: "Internal Server Error" });
			}
		}
	});

	httpServer.listen(PORT, HOST, () => {
		console.log(
			`[piece-mcp] piece-mcp-server for "${pieceName}" listening on ${HOST}:${PORT}`,
		);
		console.log(
			`[piece-mcp] Registered ${registeredTools.length} tools: ${registeredTools.map((t) => t.name).join(", ")}`,
		);
		console.log(`[piece-mcp] MCP endpoint: http://${HOST}:${PORT}/mcp`);
		console.log(`[piece-mcp] Health check: http://${HOST}:${PORT}/health`);
	});
}

main().catch((error) => {
	console.error("[piece-mcp] Fatal startup error:", error);
	process.exit(1);
});
