/**
 * Custom Server Entry for mastra-agent-tanstack
 *
 * Intercepts API routes (/api/*) before passing to TanStack Start
 * for SSR page routes. This is the recommended pattern for TanStack Start 1.x
 * which doesn't have built-in API file routes.
 */

import {
	createStartHandler,
	defaultStreamHandler,
} from "@tanstack/react-start/server";
import { eventBus } from "./lib/event-bus";
import { TOOL_NAMES } from "./lib/agent";
import { startDaprPublisher } from "./lib/dapr-publisher";
import {
	handleDaprSubscriptionEvent,
	getDaprSubscriptions,
} from "./lib/dapr-publisher";
import { handleMcpRequest, getSessionCount } from "./lib/mcp-sessions";

// ── Initialize singletons (runs once on server start) ────────
eventBus.setState({ toolNames: TOOL_NAMES });
startDaprPublisher();
console.log("[mastra-tanstack] Server entry initialized");

// ── TanStack Start handler (SSR pages + server functions) ────
const startFetch = createStartHandler(defaultStreamHandler);

// ── API route handler ────────────────────────────────────────

async function handleApiRoute(request: Request): Promise<Response | null> {
	const url = new URL(request.url);
	const path = url.pathname;
	const method = request.method;

	// Health check
	if (path === "/api/health" && method === "GET") {
		const state = eventBus.getState();
		return Response.json({
			service: "mastra-agent-tanstack",
			framework: "tanstack-start",
			mcpSessions: getSessionCount(),
			agentStatus: state.status,
			agentTools: TOOL_NAMES,
			totalRuns: state.totalRuns,
			totalTokens: state.totalTokens,
		});
	}

	// MCP endpoint (all methods)
	if (path === "/api/mcp") {
		return handleMcpRequest(request);
	}

	// Dapr subscription discovery
	if (path === "/api/dapr/subscribe" && method === "GET") {
		return Response.json(getDaprSubscriptions());
	}

	// Dapr event delivery
	if (path === "/api/dapr/sub" && method === "POST") {
		try {
			const body = (await request.json()) as Record<string, unknown>;
			handleDaprSubscriptionEvent({
				id: (body.id as string) ?? "",
				source: (body.source as string) ?? "",
				type: (body.type as string) ?? "",
				specversion: (body.specversion as string) ?? "1.0",
				datacontenttype:
					(body.datacontenttype as string) ?? "application/json",
				data: (body.data as Record<string, unknown>) ?? {},
			});
			return Response.json({ status: "SUCCESS" });
		} catch (err) {
			return Response.json({ error: String(err) }, { status: 400 });
		}
	}

	// Not an API route — return null to pass through to TanStack Start
	return null;
}

// ── Server entry (Vinxi expects { fetch } default export) ────

function createServerEntry(entry: {
	fetch: (...args: [Request, ...unknown[]]) => Promise<Response>;
}) {
	return {
		async fetch(request: Request, ...rest: unknown[]): Promise<Response> {
			// Try API routes first
			const apiResponse = await handleApiRoute(request);
			if (apiResponse) return apiResponse;

			// Fall through to TanStack Start (SSR pages, server functions)
			return entry.fetch(request, ...rest);
		},
	};
}

export { createServerEntry };
export default createServerEntry({ fetch: startFetch });
