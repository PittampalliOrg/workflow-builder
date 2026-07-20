/**
 * Goal request context
 *
 * The goal tools (create_goal/update_goal/get_goal) are session-scoped: each
 * call must resolve WHICH workflow-builder session (== codex thread) it belongs
 * to. The BFF stamps the session id into the goal MCP server entry's headers
 * (`X-Wfb-Session-Id`) at spawn time; index.ts reads that header per request and
 * runs the MCP request handler inside this AsyncLocalStorage context, so the
 * tool callbacks can recover the session id without it being a tool argument.
 * (Same pattern as piece-mcp-server's auth-resolver.)
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type SessionRequestContext = {
	sessionId?: string | null;
};

const goalContext = new AsyncLocalStorage<SessionRequestContext>();

export function runWithSessionContext<T>(
	context: SessionRequestContext,
	fn: () => T,
): T {
	return goalContext.run(context, fn);
}

export function currentSessionId(): string | null {
	const sessionId = goalContext.getStore()?.sessionId?.trim();
	return sessionId ? sessionId : null;
}
