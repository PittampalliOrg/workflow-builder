/**
 * Workflow MCP Server
 *
 * MCP server that exposes workflow builder tools over HTTP
 * (StreamableHTTP transport).
 *
 * ENV: DATABASE_URL (required), PORT (default 3200)
 */

import "./otel.js";

import http from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { initDb } from "./db.js";
import {
	registerWorkflowTools,
	type RegisteredTool,
} from "./workflow-tools.js";
import { registerGoalTools } from "./goal-tools.js";
import { registerTraceTools } from "./trace-tools.js";
import {
	registerScriptTools,
	shouldSuppressScriptTools,
} from "./script-tools.js";
import { registerTargetTools } from "./target-tools.js";
import {
	createStructuredOutputMcpServer,
	parseStructuredOutputContext,
	STRUCTURED_OUTPUT_TOOL_NAME,
} from "./structured-output-tools.js";
import { runWithGoalContext } from "./goal-context.js";
import {
	runWithTeamContext,
	shouldSuppressTeamTools,
} from "./team-context.js";
import { registerTeamTools } from "./team-tools.js";
import { setSpanInput, setSpanOutput } from "./observability/content.js";

const PORT = parseInt(process.env.PORT || "3200", 10);
const HOST = process.env.HOST || "0.0.0.0";
const RESPONSE_CAPTURE_MAX_BYTES = 60_000;

// Session-scoped transports
const sessions = new Map<string, StreamableHTTPServerTransport>();

// Loaded at startup
let registeredTools: RegisteredTool[] = [];
const STRUCTURED_OUTPUT_HEALTH_TOOLS: RegisteredTool[] = [
	{
		name: STRUCTURED_OUTPUT_TOOL_NAME,
		description: "Session-scoped structured-output tool",
	},
];

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
	const originalEnd = res.end.bind(res) as (
		...args: any[]
	) => http.ServerResponse;
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

	res.write = ((
		chunk: unknown,
		encodingOrCallback?:
			| BufferEncoding
			| ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	) => {
		capture(
			chunk,
			typeof encodingOrCallback === "string" ? encodingOrCallback : undefined,
		);
		return typeof encodingOrCallback === "function"
			? originalWrite(chunk, encodingOrCallback)
			: originalWrite(chunk, encodingOrCallback, callback);
	}) as typeof res.write;

	res.end = ((
		chunk?: unknown,
		encodingOrCallback?: BufferEncoding | (() => void),
		callback?: () => void,
	) => {
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

/** Options controlling which tool groups a server instance exposes. */
type CreateMcpServerOptions = {
	// Recursion guard: script-spawned sessions carry X-Wfb-Script-Depth, which
	// suppresses run_workflow_script so a running script can't launch more.
	suppressScriptTools?: boolean;
	// Nesting guard: teammate sessions carry X-Wfb-Team-Depth, which suppresses
	// the team tools so a teammate can't spawn its own nested team.
	suppressTeamTools?: boolean;
};

/** Create a new MCP Server instance with workflow tools. */
function createMcpServer(
	userId?: string,
	opts?: CreateMcpServerOptions,
): Server {
	const mcpServer = new McpServer(
		{ name: "workflow-builder-mcp", version: "1.0.0" },
		{ capabilities: { tools: {}, resources: {} } },
	);

	// Current workflow tools are UI-independent. The legacy Remote DOM/canvas
	// authoring tools are no longer registered by workflow-tools.ts.
	registerTargetTools(mcpServer);
	registerWorkflowTools(mcpServer, undefined, userId);
	// Goal tools register regardless of the UI so any MCP-capable agent runtime
	// can drive the Codex-/goal-parity loop. Session scope comes from the
	// per-request X-Wfb-Session-Id header (see runWithGoalContext wraps below).
	registerGoalTools(mcpServer);
	registerTraceTools(mcpServer);

	// Dynamic workflow script tool — also UI-independent. Suppressed inside
	// script-spawned sessions (recursion guard) via suppressScriptTools.
	if (opts?.suppressScriptTools !== true) {
		registerScriptTools(mcpServer);
	}

	// Team tools register for team members (lead + peers); suppressed for teammate
	// sessions carrying X-Wfb-Team-Depth so nested teams can't form. Session scope
	// comes from X-Wfb-Session-Id, team scope from X-Wfb-Team-Id (see the
	// runWithTeamContext wraps below).
	if (opts?.suppressTeamTools !== true) {
		registerTeamTools(mcpServer);
	}

	return mcpServer.server;
}

// ── HTTP Request Handler ─────────────────────────────────────

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	setCorsHeaders(res);
	installResponseCapture(res);

	const url = req.url ?? "/";
	const method = req.method ?? "GET";

	if (method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	if (url === "/health" && method === "GET") {
		let toolList = registeredTools;
		try {
			if (parseStructuredOutputContext(req.headers)) {
				toolList = STRUCTURED_OUTPUT_HEALTH_TOOLS;
			}
		} catch (error) {
			sendJson(res, 400, {
				error: {
					message:
						error instanceof Error
							? error.message
							: `Invalid structured-output MCP context: ${String(error)}`,
				},
			});
			return;
		}
		sendJson(res, 200, {
			service: "workflow-builder-mcp",
			tools: toolList.length,
			toolNames: toolList.map((t) => t.name),
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
	setSpanInput({ sessionId, body });

	if (sessionId && sessions.has(sessionId)) {
		transport = sessions.get(sessionId)!;
	} else if (!sessionId && isInitializeRequest(body)) {
		const userId = (req.headers["x-user-id"] as string) || undefined;

		transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			onsessioninitialized: (sid) => {
				sessions.set(sid, transport);
				console.log(
					`[wf-mcp] New session: ${sid}${userId ? ` (user: ${userId})` : ""}`,
				);
			},
		});

		transport.onclose = () => {
			if (transport.sessionId) {
				sessions.delete(transport.sessionId);
				console.log(`[wf-mcp] Session closed: ${transport.sessionId}`);
			}
		};

		// Recursion guard: a present X-Wfb-Script-Depth header (stamped by the BFF
		// on the MCP entry for script-spawned sessions) suppresses the dynamic
		// script tool so a running script can't launch further scripts.
		const suppressScriptTools = shouldSuppressScriptTools(req.headers);
		const suppressTeamTools = shouldSuppressTeamTools(req.headers);

		let structuredOutputContext;
		try {
			structuredOutputContext = parseStructuredOutputContext(req.headers);
		} catch (error) {
			sendJson(res, 400, {
				error: {
					message:
						error instanceof Error
							? error.message
							: `Invalid structured-output MCP context: ${String(error)}`,
				},
			});
			return;
		}
		const server = structuredOutputContext
			? createStructuredOutputMcpServer(structuredOutputContext.schema)
			: createMcpServer(userId, { suppressScriptTools, suppressTeamTools });
		await server.connect(transport);
	} else {
		sendJson(res, 400, {
			error: { message: "Bad Request: No valid session ID provided" },
		});
		return;
	}

	// Bind the workflow-builder session (codex thread) for this request so the
	// goal tools can resolve which session they act on.
	const wfbSessionId = req.headers["x-wfb-session-id"] as string | undefined;
	const wfbTeamId = req.headers["x-wfb-team-id"] as string | undefined;
	await runWithGoalContext({ sessionId: wfbSessionId ?? null }, () =>
		runWithTeamContext({ teamId: wfbTeamId ?? null }, () =>
			transport.handleRequest(req, res, body),
		),
	);
}

async function handleMcpGet(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	setSpanInput({ method: "GET", path: "/mcp", sessionId });
	if (!sessionId || !sessions.has(sessionId)) {
		sendJson(res, 404, { error: "Session not found" });
		return;
	}
	const transport = sessions.get(sessionId)!;
	const wfbSessionId = req.headers["x-wfb-session-id"] as string | undefined;
	const wfbTeamId = req.headers["x-wfb-team-id"] as string | undefined;
	await runWithGoalContext({ sessionId: wfbSessionId ?? null }, () =>
		runWithTeamContext({ teamId: wfbTeamId ?? null }, () =>
			transport.handleRequest(req, res),
		),
	);
}

async function handleMcpDelete(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	setSpanInput({ method: "DELETE", path: "/mcp", sessionId });
	if (!sessionId || !sessions.has(sessionId)) {
		sendJson(res, 404, { error: "Session not found" });
		return;
	}
	const transport = sessions.get(sessionId)!;
	const wfbSessionId = req.headers["x-wfb-session-id"] as string | undefined;
	const wfbTeamId = req.headers["x-wfb-team-id"] as string | undefined;
	await runWithGoalContext({ sessionId: wfbSessionId ?? null }, () =>
		runWithTeamContext({ teamId: wfbTeamId ?? null }, () =>
			transport.handleRequest(req, res),
		),
	);
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
	// Initialize database pool
	console.log("[wf-mcp] Initializing database connection...");
	initDb();

	// Dry-run registration to count the normal-mode MCP surface. Structured
	// output is a separate header-selected mode and is reported separately by
	// /health when those headers are present.
	{
		const dryServer = new McpServer(
			{ name: "dry-run", version: "0.0.0" },
			{ capabilities: { tools: {}, resources: {} } },
		);
		registeredTools = [
			...registerTargetTools(dryServer),
			...registerWorkflowTools(dryServer),
		];
	}
	// Always count the goal tools.
	{
		const dryGoalServer = new McpServer(
			{ name: "dry-run-goal", version: "0.0.0" },
			{ capabilities: { tools: {} } },
		);
		registeredTools = [...registeredTools, ...registerGoalTools(dryGoalServer)];
	}
	// Count trace tools, which are session-scoped but part of the normal MCP
	// surface. They fail closed at call time if no X-Wfb-Session-Id is present.
	{
		const dryTraceServer = new McpServer(
			{ name: "dry-run-trace", version: "0.0.0" },
			{ capabilities: { tools: {} } },
		);
		registeredTools = [
			...registeredTools,
			...registerTraceTools(dryTraceServer),
		];
	}
	// Count the dynamic workflow script tool (suppressed only inside
	// script-spawned sessions).
	{
		const dryScriptServer = new McpServer(
			{ name: "dry-run-script", version: "0.0.0" },
			{ capabilities: { tools: {} } },
		);
		registeredTools = [
			...registeredTools,
			...registerScriptTools(dryScriptServer),
		];
	}
	// Count the team tools (suppressed only for teammate sessions carrying
	// X-Wfb-Team-Depth). Session/team scope resolves at call time.
	{
		const dryTeamServer = new McpServer(
			{ name: "dry-run-team", version: "0.0.0" },
			{ capabilities: { tools: {} } },
		);
		registeredTools = [
			...registeredTools,
			...registerTeamTools(dryTeamServer),
		];
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
		console.log(`[wf-mcp] workflow-mcp-server listening on ${HOST}:${PORT}`);
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
