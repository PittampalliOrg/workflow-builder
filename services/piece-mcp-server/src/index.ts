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
	type ToolAllowlist,
} from "./piece-to-mcp.js";
import { validateCatalogMetadata } from "./metadata-catalog.js";
import { handleExecute } from "./routes/execute.js";
import { handleOptions } from "./routes/options.js";
import {
	runWithRequestAuthContext,
	type RequestAuthContext,
} from "./auth-resolver.js";
import type { Piece } from "@activepieces/pieces-framework";
import { setSpanInput, setSpanOutput } from "./observability/content.js";

const PORT = parseInt(process.env.PORT || "3100", 10);
const HOST = process.env.HOST || "0.0.0.0";
const RESPONSE_CAPTURE_MAX_BYTES = 60_000;

// Session-scoped transports
const sessions = new Map<string, StreamableHTTPServerTransport>();
const sessionAuthContexts = new Map<string, RequestAuthContext>();

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
	setSpanOutput(data);
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

function installResponseCapture(res: http.ServerResponse): void {
	const originalWrite = res.write.bind(res) as (...args: any[]) => boolean;
	const originalEnd = res.end.bind(res) as (...args: any[]) => http.ServerResponse;
	const chunks: Buffer[] = [];
	let capturedBytes = 0;
	let finished = false;

	const capture = (chunk: unknown, encoding?: BufferEncoding): void => {
		if (chunk == null || capturedBytes >= RESPONSE_CAPTURE_MAX_BYTES) return;
		const buffer = Buffer.isBuffer(chunk)
			? chunk
			: ArrayBuffer.isView(chunk)
				? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
				: chunk instanceof ArrayBuffer
					? Buffer.from(chunk)
					: Buffer.from(String(chunk), encoding);
		const remaining = RESPONSE_CAPTURE_MAX_BYTES - capturedBytes;
		const selected =
			buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
		chunks.push(selected);
		capturedBytes += selected.byteLength;
	};

	res.write = ((chunk: unknown, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
		capture(
			chunk,
			typeof encodingOrCallback === "string" ? encodingOrCallback : undefined,
		);
		return typeof encodingOrCallback === "function"
			? originalWrite(chunk, encodingOrCallback)
			: originalWrite(chunk, encodingOrCallback, callback);
	}) as typeof res.write;

	res.end = ((chunk?: unknown, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) => {
		if (finished) {
			return typeof encodingOrCallback === "function"
				? originalEnd(chunk, encodingOrCallback)
				: originalEnd(chunk, encodingOrCallback, callback);
		}
		finished = true;
		capture(
			chunk,
			typeof encodingOrCallback === "string" ? encodingOrCallback : undefined,
		);
		if (chunks.length > 0) {
			setSpanOutput(Buffer.concat(chunks).toString("utf-8"));
		}
		return typeof encodingOrCallback === "function"
			? originalEnd(chunk, encodingOrCallback)
			: originalEnd(chunk, encodingOrCallback, callback);
	}) as typeof res.end;
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

function firstHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

/**
 * Parse the `?tools=a,b` allowlist from the request URL (set by the BFF
 * from `mcp_connection.metadata.toolSelection`). Param absent → null (no
 * restriction). Param present but empty → [] (all tools disabled).
 */
function toolAllowlistFromUrl(url: URL): ToolAllowlist {
	const raw = url.searchParams.get("tools");
	if (raw === null) return null;
	return raw
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
}

function authContextFromRequest(
	req: http.IncomingMessage,
	sessionId?: string,
): RequestAuthContext {
	const connectionExternalId =
		firstHeader(req.headers["x-connection-external-id"])
			?.trim()
			|| firstHeader(req.headers["x-workflow-builder-connection-external-id"])
				?.trim()
			|| (sessionId
				? sessionAuthContexts.get(sessionId)?.connectionExternalId?.trim()
				: undefined)
			|| undefined;
	return { connectionExternalId };
}

/**
 * Create a new MCP Server instance with piece tools registered, filtered
 * by the per-session tool allowlist (from `?tools=` on the initialize
 * request URL; null = all tools).
 */
function createMcpServer(toolAllowlist: ToolAllowlist = null): Server {
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
			toolAllowlist,
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

	registerPieceTools(server, piece, metadata, normalizePieceName(pieceName), toolAllowlist);
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
		const normalizedName = normalizePieceName(name);
		const result = await client.query<{
			actions: Record<string, unknown> | null;
			auth: unknown;
			display_name: string | null;
			version: string | null;
			catalog_schema_version: number | null;
			catalog_digest: string | null;
			catalog_source_image: string | null;
			catalog_synced_at: string | null;
		}>(
			`SELECT actions, auth, display_name, version, catalog_schema_version, catalog_digest, catalog_source_image, catalog_synced_at
			 FROM piece_metadata
			 WHERE name IN ($1, $2)
			 ORDER BY updated_at DESC
			 LIMIT 1`,
			[normalizedName, `@activepieces/piece-${normalizedName}`],
		);

		if (result.rows.length === 0) {
			throw new Error(
				`No metadata found for piece "${name}" in piece_metadata table. ` +
					"Run the piece-mcp-server metadata sync command before reconciling AP MCP services.",
			);
		}

		const row = result.rows[0];
		const metadata = {
			actions: row.actions as PieceMetadataRow["actions"],
			auth: row.auth,
			displayName: row.display_name,
			version: row.version,
			catalogSchemaVersion: row.catalog_schema_version,
			catalogDigest: row.catalog_digest,
			catalogSourceImage: row.catalog_source_image,
			catalogSyncedAt: row.catalog_synced_at,
		};
		validateCatalogMetadata({ pieceName: name, piece, row: metadata });
		return metadata;
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
	installResponseCapture(res);

	// Route on the pathname so query params (e.g. /mcp?tools=a,b — the
	// tool-selection allowlist) don't break the route match.
	const parsedUrl = new URL(req.url ?? "/", "http://localhost");
	const url = parsedUrl.pathname;
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
			pieceVersion: metadata.version ?? null,
			tools: registeredTools.length,
			toolNames: registeredTools.map((t) => t.name),
			hasUI,
			endpoints: ["/mcp", "/execute", "/options", "/health"],
		});
		return;
	}

	// Deterministic activity execution (orchestrator → function-router → here)
	if (url === "/execute" && method === "POST") {
		const body = await parseBody(req);
		const requestAuthContext = authContextFromRequest(req);
		await runWithRequestAuthContext(requestAuthContext, () =>
			handleExecute(req, res, body, { piece, pieceName, metadata }),
		);
		return;
	}

	// Dynamic dropdown options for the canvas UI
	if (url === "/options" && method === "POST") {
		const body = await parseBody(req);
		const requestAuthContext = authContextFromRequest(req);
		await runWithRequestAuthContext(requestAuthContext, () =>
			handleOptions(req, res, body, { piece, pieceName }),
		);
		return;
	}

	// MCP routes
	if (url === "/mcp") {
		if (method === "POST") {
			await handleMcpPost(req, res, parsedUrl);
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
	parsedUrl: URL,
): Promise<void> {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	let transport: StreamableHTTPServerTransport;
	const requestAuthContext = authContextFromRequest(req, sessionId);

	const body = await parseBody(req);
	setSpanInput({
		pieceName,
		sessionId,
		connectionExternalIdPresent: Boolean(requestAuthContext.connectionExternalId),
		body,
	});

	if (sessionId && sessions.has(sessionId)) {
		// Existing session
		transport = sessions.get(sessionId)!;
		if (requestAuthContext.connectionExternalId) {
			sessionAuthContexts.set(sessionId, requestAuthContext);
		}
	} else if (!sessionId && isInitializeRequest(body)) {
		// New session
		transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			onsessioninitialized: (sid) => {
				sessions.set(sid, transport);
				if (requestAuthContext.connectionExternalId) {
					sessionAuthContexts.set(sid, requestAuthContext);
				}
				console.log(`[piece-mcp] New session: ${sid}`);
			},
		});

		transport.onclose = () => {
			if (transport.sessionId) {
				sessions.delete(transport.sessionId);
				sessionAuthContexts.delete(transport.sessionId);
				console.log(`[piece-mcp] Session closed: ${transport.sessionId}`);
			}
		};

		// Tool-selection enforcement: the allowlist rides the URL the client
		// was handed (?tools=a,b); the session's server only registers those.
		const server = createMcpServer(toolAllowlistFromUrl(parsedUrl));
		await server.connect(transport);
	} else {
		sendJson(res, 400, {
			error: { message: "Bad Request: No valid session ID provided" },
		});
		return;
	}

	await runWithRequestAuthContext(requestAuthContext, () =>
		transport.handleRequest(req, res, body),
	);
}

async function handleMcpGet(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	const requestAuthContext = authContextFromRequest(req, sessionId);
	setSpanInput({
		pieceName,
		method: "GET",
		path: "/mcp",
		sessionId,
		connectionExternalIdPresent: Boolean(requestAuthContext.connectionExternalId),
	});
	if (!sessionId || !sessions.has(sessionId)) {
		sendJson(res, 404, { error: "Session not found" });
		return;
	}
	const transport = sessions.get(sessionId)!;
	if (requestAuthContext.connectionExternalId) {
		sessionAuthContexts.set(sessionId, requestAuthContext);
	}
	await runWithRequestAuthContext(requestAuthContext, () =>
		transport.handleRequest(req, res),
	);
}

async function handleMcpDelete(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	const requestAuthContext = authContextFromRequest(req, sessionId);
	setSpanInput({
		pieceName,
		method: "DELETE",
		path: "/mcp",
		sessionId,
		connectionExternalIdPresent: Boolean(requestAuthContext.connectionExternalId),
	});
	if (!sessionId || !sessions.has(sessionId)) {
		sendJson(res, 404, { error: "Session not found" });
		return;
	}
	const transport = sessions.get(sessionId)!;
	await runWithRequestAuthContext(requestAuthContext, () =>
		transport.handleRequest(req, res),
	);
	sessions.delete(sessionId);
	sessionAuthContexts.delete(sessionId);
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
		`[piece-mcp] Loaded metadata: ${metadata.displayName ?? pieceName} digest=${metadata.catalogDigest} source=${metadata.catalogSourceImage ?? "unknown"}`,
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
		registeredTools = registerPieceTools(dryServer, piece, metadata, normalizedName);
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
