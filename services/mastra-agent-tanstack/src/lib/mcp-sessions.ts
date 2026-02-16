/**
 * MCP Session Management (Web Standard transport)
 *
 * Manages MCP sessions using WebStandardStreamableHTTPServerTransport.
 * Works natively with web Request/Response — no node:http adapter needed.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp-server";

const sessions = new Map<
	string,
	WebStandardStreamableHTTPServerTransport
>();
const sessionLastActive = new Map<string, number>();

// ── Session cleanup: reap stale sessions every 30s ──
const SESSION_TTL_MS = 60_000; // 60s inactivity timeout
const MAX_SESSIONS = 50;

setInterval(() => {
	const now = Date.now();
	let cleaned = 0;
	for (const [sid, lastActive] of sessionLastActive) {
		if (now - lastActive > SESSION_TTL_MS) {
			const transport = sessions.get(sid);
			if (transport) {
				try { transport.close?.(); } catch { /* ignore */ }
			}
			sessions.delete(sid);
			sessionLastActive.delete(sid);
			cleaned++;
		}
	}
	if (cleaned > 0) {
		console.log(`[mastra-tanstack] Cleaned up ${cleaned} stale sessions (${sessions.size} remaining)`);
	}
}, 30_000);

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function addCorsHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [k, v] of Object.entries(CORS_HEADERS)) {
		headers.set(k, v);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function corsResponse(status: number = 204): Response {
	return new Response(null, { status, headers: CORS_HEADERS });
}

function jsonResponse(status: number, data: unknown): Response {
	const headers = new Headers(CORS_HEADERS);
	headers.set("Content-Type", "application/json");
	return new Response(JSON.stringify(data), { status, headers });
}

/**
 * Handle MCP requests using web standard Request/Response.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
	const method = request.method;

	// CORS preflight
	if (method === "OPTIONS") {
		return corsResponse(204);
	}

	const sessionId = request.headers.get("mcp-session-id") ?? undefined;

	if (method === "POST") {
		return handleMcpPost(request, sessionId);
	} else if (method === "GET" || method === "DELETE") {
		return handleMcpGetOrDelete(request, sessionId);
	}

	return jsonResponse(405, { error: "Method Not Allowed" });
}

async function handleMcpPost(
	request: Request,
	sessionId?: string,
): Promise<Response> {
	// Parse the body to check if it's an initialize request
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return jsonResponse(400, { error: "Invalid JSON body" });
	}

	let transport: WebStandardStreamableHTTPServerTransport;

	if (sessionId && sessions.has(sessionId)) {
		// Existing session — update activity timestamp
		transport = sessions.get(sessionId)!;
		sessionLastActive.set(sessionId, Date.now());
	} else if (!sessionId && isInitializeRequest(body)) {
		// Evict oldest sessions if at capacity
		if (sessions.size >= MAX_SESSIONS) {
			let oldestSid: string | null = null;
			let oldestTime = Infinity;
			for (const [sid, ts] of sessionLastActive) {
				if (ts < oldestTime) {
					oldestTime = ts;
					oldestSid = sid;
				}
			}
			if (oldestSid) {
				const oldTransport = sessions.get(oldestSid);
				if (oldTransport) {
					try { oldTransport.close?.(); } catch { /* ignore */ }
				}
				sessions.delete(oldestSid);
				sessionLastActive.delete(oldestSid);
				console.log(`[mastra-tanstack] Evicted oldest session (at capacity ${MAX_SESSIONS})`);
			}
		}

		// New session — create transport and connect MCP server
		transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			onsessioninitialized: (sid) => {
				sessions.set(sid, transport);
				sessionLastActive.set(sid, Date.now());
				console.log(`[mastra-tanstack] New MCP session: ${sid} (total: ${sessions.size})`);
			},
		});

		transport.onclose = () => {
			const sid = transport.sessionId;
			if (sid) {
				sessions.delete(sid);
				sessionLastActive.delete(sid);
			}
		};

		const server = createMcpServer();
		await server.connect(transport);
	} else {
		return jsonResponse(400, {
			error: { message: "Bad Request: No valid session ID provided" },
		});
	}

	// Reconstruct the request with the already-parsed body
	// The transport needs to re-read the body, so we create a new Request
	const newRequest = new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body: JSON.stringify(body),
	});

	const response = await transport.handleRequest(newRequest, {
		parsedBody: body,
	});
	return addCorsHeaders(response);
}

async function handleMcpGetOrDelete(
	request: Request,
	sessionId?: string,
): Promise<Response> {
	if (!sessionId || !sessions.has(sessionId)) {
		return jsonResponse(404, { error: "Session not found" });
	}
	const transport = sessions.get(sessionId)!;
	const response = await transport.handleRequest(request);
	return addCorsHeaders(response);
}

export function getSessionCount(): number {
	return sessions.size;
}
