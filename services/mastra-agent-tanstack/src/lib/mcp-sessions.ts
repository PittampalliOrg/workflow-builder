/**
 * MCP Session Management (WebStandard transport)
 *
 * Manages MCP sessions using StreamableHTTPServerTransport.
 * Uses the node:http transport with H3 event access from TanStack Start/Nitro.
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp-server";

const sessions = new Map<string, StreamableHTTPServerTransport>();

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function corsHeaders(): Headers {
	const headers = new Headers();
	for (const [k, v] of Object.entries(CORS_HEADERS)) {
		headers.set(k, v);
	}
	return headers;
}

/**
 * Handle MCP requests using web standard Request/Response.
 *
 * Because StreamableHTTPServerTransport works with node:http IncomingMessage/ServerResponse,
 * we adapt the web standard Request into node-compatible objects and collect the response.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
	const method = request.method;

	// CORS preflight
	if (method === "OPTIONS") {
		return new Response(null, { status: 204, headers: corsHeaders() });
	}

	const sessionId = request.headers.get("mcp-session-id") ?? undefined;

	if (method === "POST") {
		return handleMcpPost(request, sessionId);
	} else if (method === "GET") {
		return handleMcpGet(request, sessionId);
	} else if (method === "DELETE") {
		return handleMcpDelete(request, sessionId);
	}

	return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
}

async function handleMcpPost(request: Request, sessionId?: string): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return jsonResponse(400, { error: "Invalid JSON body" });
	}

	let transport: StreamableHTTPServerTransport;

	if (sessionId && sessions.has(sessionId)) {
		transport = sessions.get(sessionId)!;
	} else if (!sessionId && isInitializeRequest(body)) {
		// Create new session
		transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			onsessioninitialized: (sid) => {
				sessions.set(sid, transport);
				console.log(`[mastra-tanstack] New MCP session: ${sid}`);
			},
		});

		transport.onclose = () => {
			if (transport.sessionId) {
				sessions.delete(transport.sessionId);
				console.log(`[mastra-tanstack] MCP session closed: ${transport.sessionId}`);
			}
		};

		const server = createMcpServer();
		await server.connect(transport);
	} else {
		return jsonResponse(400, {
			error: { message: "Bad Request: No valid session ID provided" },
		});
	}

	// Use the transport's web-standard handler if available,
	// otherwise fall back to node adapter
	return transportHandleWeb(transport, request, body);
}

async function handleMcpGet(_request: Request, sessionId?: string): Promise<Response> {
	if (!sessionId || !sessions.has(sessionId)) {
		return jsonResponse(404, { error: "Session not found" });
	}
	const transport = sessions.get(sessionId)!;
	return transportHandleWeb(transport, _request);
}

async function handleMcpDelete(_request: Request, sessionId?: string): Promise<Response> {
	if (!sessionId || !sessions.has(sessionId)) {
		return jsonResponse(404, { error: "Session not found" });
	}
	const transport = sessions.get(sessionId)!;
	return transportHandleWeb(transport, _request);
}

/**
 * Adapt a web Request to the StreamableHTTPServerTransport.
 *
 * The transport expects node:http objects. We create minimal
 * node-compatible adapters from the web Request.
 */
async function transportHandleWeb(
	transport: StreamableHTTPServerTransport,
	request: Request,
	body?: unknown,
): Promise<Response> {
	const { EventEmitter } = await import("node:events");

	// Create a minimal node IncomingMessage-like object
	const fakeReq = Object.assign(new EventEmitter(), {
		method: request.method,
		url: new URL(request.url).pathname,
		headers: Object.fromEntries(request.headers.entries()),
		// Socket mock for keep-alive
		socket: { remoteAddress: "127.0.0.1" },
	}) as any;

	// Create a minimal node ServerResponse-like object
	let statusCode = 200;
	const responseHeaders: Record<string, string | string[]> = {};
	const chunks: Buffer[] = [];
	let resolveResponse: (value: Response) => void;
	let headersSent = false;

	const responsePromise = new Promise<Response>((resolve) => {
		resolveResponse = resolve;
	});

	const fakeRes = Object.assign(new EventEmitter(), {
		statusCode: 200,
		headersSent: false,

		writeHead(code: number, headers?: Record<string, string | string[]>) {
			statusCode = code;
			fakeRes.statusCode = code;
			if (headers) {
				for (const [k, v] of Object.entries(headers)) {
					responseHeaders[k] = v;
				}
			}
			return fakeRes;
		},

		setHeader(name: string, value: string | string[]) {
			responseHeaders[name] = value;
			return fakeRes;
		},

		getHeader(name: string) {
			return responseHeaders[name];
		},

		write(chunk: string | Buffer) {
			if (!headersSent) {
				headersSent = true;
				fakeRes.headersSent = true;
			}
			const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			chunks.push(buf);
			return true;
		},

		end(data?: string | Buffer) {
			if (data) {
				const buf = typeof data === "string" ? Buffer.from(data) : data;
				chunks.push(buf);
			}
			if (!headersSent) {
				headersSent = true;
				fakeRes.headersSent = true;
			}

			const resHeaders = new Headers();
			for (const [k, v] of Object.entries(CORS_HEADERS)) {
				resHeaders.set(k, v);
			}
			for (const [k, v] of Object.entries(responseHeaders)) {
				if (Array.isArray(v)) {
					for (const val of v) resHeaders.append(k, val);
				} else {
					resHeaders.set(k, v as string);
				}
			}

			const body = Buffer.concat(chunks);
			resolveResponse!(new Response(body.length > 0 ? body : null, {
				status: statusCode,
				headers: resHeaders,
			}));
			return fakeRes;
		},

		flushHeaders() {},
	}) as any;

	// Check if the content-type indicates SSE (GET requests for streaming)
	// For SSE, we need a streaming response
	const isSSE = request.method === "GET";

	if (isSSE) {
		// For SSE, create a streaming response
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();

		// Override write/end for SSE streaming
		fakeRes.write = (chunk: string | Buffer) => {
			const str = typeof chunk === "string" ? chunk : chunk.toString();
			writer.write(encoder.encode(str)).catch(() => {});
			if (!headersSent) {
				headersSent = true;
				fakeRes.headersSent = true;
			}
			return true;
		};

		fakeRes.end = (data?: string | Buffer) => {
			if (data) {
				const str = typeof data === "string" ? data : data.toString();
				writer.write(encoder.encode(str)).catch(() => {});
			}
			writer.close().catch(() => {});
			return fakeRes;
		};

		// Handle the transport request asynchronously
		transport.handleRequest(fakeReq, fakeRes, body).catch((err: unknown) => {
			console.error("[mastra-tanstack] SSE transport error:", err);
			writer.close().catch(() => {});
		});

		// Wait a tick for headers to be set
		await new Promise((r) => setTimeout(r, 10));

		const sseHeaders = new Headers();
		for (const [k, v] of Object.entries(CORS_HEADERS)) {
			sseHeaders.set(k, v);
		}
		sseHeaders.set("Content-Type", "text/event-stream");
		sseHeaders.set("Cache-Control", "no-cache");
		sseHeaders.set("Connection", "keep-alive");
		for (const [k, v] of Object.entries(responseHeaders)) {
			if (Array.isArray(v)) {
				for (const val of v) sseHeaders.append(k, val);
			} else {
				sseHeaders.set(k, v as string);
			}
		}

		return new Response(readable, {
			status: statusCode,
			headers: sseHeaders,
		});
	}

	// For POST/DELETE, the response completes synchronously
	await transport.handleRequest(fakeReq, fakeRes, body);
	return responsePromise;
}

function jsonResponse(status: number, data: unknown): Response {
	const headers = corsHeaders();
	headers.set("Content-Type", "application/json");
	return new Response(JSON.stringify(data), { status, headers });
}

export function getSessionCount(): number {
	return sessions.size;
}
