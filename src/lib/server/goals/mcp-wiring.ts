/**
 * Workflow MCP header helper, shared by the direct-spawn path
 * (`src/lib/server/sessions/spawn.ts`) and the workflow→session bridge
 * (`/api/internal/sessions/ensure-for-workflow`).
 *
 * The goal MCP auto-wire (create_goal/update_goal/get_goal) was REMOVED —
 * goals are authored in code via the dynamic-script engine and completed by
 * the BFF evidence backstop, so agents no longer self-declare or self-complete
 * goals over MCP. This module now only carries the run_workflow_script
 * recursion guard, which still applies to any explicitly-configured Workflow
 * MCP server entry.
 */

export const WORKFLOW_MCP_SERVER_URL =
	process.env.WORKFLOW_MCP_SERVER_URL ??
	"http://workflow-mcp-server.workflow-builder.svc.cluster.local:3200/mcp";

function normalizedMcpUrl(value: unknown): string {
	return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function isTrustedWorkflowMcpServer(entry: unknown): boolean {
	if (!entry || typeof entry !== "object") return false;
	return (
		normalizedMcpUrl((entry as Record<string, unknown>).url) ===
		normalizedMcpUrl(WORKFLOW_MCP_SERVER_URL)
	);
}

/**
 * Add the short-lived platform session credential only to an explicitly
 * configured Workflow MCP entry. This does not auto-wire a server. Exact URL
 * matching prevents a caller-controlled server name or lookalike hostname from
 * receiving the credential.
 */
export function stampWorkflowMcpSessionAuth<T>(
	servers: T,
	sessionId: string,
	sessionToken: string | null,
): T {
	if (!Array.isArray(servers) || !sessionId || !sessionToken) return servers;
	return servers.map((entry) => {
		if (!isTrustedWorkflowMcpServer(entry)) return entry;
		const server = entry as Record<string, unknown>;
		const headers = Object.fromEntries(
			Object.entries(
				(server.headers as Record<string, unknown> | undefined) ?? {},
			).filter(
				([key]) =>
					!["x-wfb-session-id", "x-wfb-session-token"].includes(
						key.toLowerCase(),
					),
			),
		);
		return {
			...server,
			headers: {
				...headers,
				"X-Wfb-Session-Id": sessionId,
				"X-Wfb-Session-Token": sessionToken,
			},
		};
	}) as T;
}

/**
 * Legacy recursion marker retained during the staged MCP rollout. The current
 * server authorizes recursion depth only from the BFF-signed session credential;
 * this unsigned header grants no capability. It remains scoped to the Workflow
 * MCP entry so older server pods stay fail-closed while the rollout converges.
 */
export function stampScriptGuardHeader<T>(servers: T): T {
	if (!Array.isArray(servers)) return servers;
	return servers.map((entry) => {
		if (!entry || typeof entry !== "object") return entry;
		const e = entry as Record<string, unknown>;
		const name = typeof e.name === "string" ? e.name.toLowerCase() : "";
		const url = typeof e.url === "string" ? e.url : "";
		const isWorkflowMcpServer =
			/script/.test(name) || url.includes("workflow-mcp-server");
		if (!isWorkflowMcpServer) return entry;
		const headers = {
			...((e.headers as Record<string, unknown> | undefined) ?? {}),
			"X-Wfb-Script-Depth": "1",
		};
		return { ...e, headers };
	}) as T;
}
