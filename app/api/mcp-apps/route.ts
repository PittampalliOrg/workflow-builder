import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpAppsServer } from "@/lib/mcp-apps/server";

// Session-scoped transports keyed by session ID
const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "*",
		"Access-Control-Expose-Headers": "Mcp-Session-Id",
	};
}

export async function OPTIONS() {
	return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function POST(request: Request) {
	const sessionId = request.headers.get("mcp-session-id") ?? undefined;
	let transport: WebStandardStreamableHTTPServerTransport;

	const body = await request.json();

	if (sessionId && transports.has(sessionId)) {
		transport = transports.get(sessionId)!;
	} else if (!sessionId && isInitializeRequest(body)) {
		// New session initialization
		transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			onsessioninitialized: (sid) => {
				transports.set(sid, transport);
			},
		});

		transport.onclose = () => {
			if (transport.sessionId) {
				transports.delete(transport.sessionId);
			}
		};

		const server = createMcpAppsServer();
		await server.connect(transport);
	} else {
		return new Response(
			JSON.stringify({
				error: { message: "Bad Request: No valid session ID provided" },
			}),
			{
				status: 400,
				headers: { "Content-Type": "application/json", ...corsHeaders() },
			},
		);
	}

	const response = await transport.handleRequest(request, { parsedBody: body });

	// Merge CORS headers into the response
	const merged = new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: new Headers([
			...response.headers.entries(),
			...Object.entries(corsHeaders()),
		]),
	});
	return merged;
}

export async function GET(request: Request) {
	const sessionId = request.headers.get("mcp-session-id") ?? undefined;
	if (!sessionId || !transports.has(sessionId)) {
		return new Response("Session not found", {
			status: 404,
			headers: corsHeaders(),
		});
	}
	const transport = transports.get(sessionId)!;
	const response = await transport.handleRequest(request);
	const merged = new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: new Headers([
			...response.headers.entries(),
			...Object.entries(corsHeaders()),
		]),
	});
	return merged;
}

export async function DELETE(request: Request) {
	const sessionId = request.headers.get("mcp-session-id") ?? undefined;
	if (!sessionId || !transports.has(sessionId)) {
		return new Response("Session not found", {
			status: 404,
			headers: corsHeaders(),
		});
	}
	const transport = transports.get(sessionId)!;
	const response = await transport.handleRequest(request);
	const merged = new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: new Headers([
			...response.headers.entries(),
			...Object.entries(corsHeaders()),
		]),
	});
	return merged;
}
