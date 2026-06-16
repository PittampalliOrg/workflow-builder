/**
 * Goal MCP wiring helpers, shared by the direct-spawn path
 * (`src/lib/server/sessions/spawn.ts`) and the workflow→session bridge
 * (`/api/internal/sessions/ensure-for-workflow`). Auto-wires the goal MCP
 * server (create_goal/update_goal/get_goal) into MCP-capable, custom-loop goal
 * sessions so the agent can self-complete its goal, and stamps the session id
 * so the goal tools resolve which session they act on.
 */

export const GOAL_MCP_SERVER_URL =
	process.env.GOAL_MCP_SERVER_URL ??
	"http://workflow-mcp-server.workflow-builder.svc.cluster.local:3200/mcp";

/**
 * Auto-wire the goal MCP server into every MCP-capable session so goals can
 * always self-complete — without the tools, a goal loop can only end via
 * budget/iteration caps or a manual pause. Skipped when the runtime doesn't
 * support MCP, when an entry already matches the goal server, when
 * GOAL_MCP_AUTO_WIRE=false, or for native-goal CLIs (they drive their OWN
 * `/goal` loop with its own completion harness).
 */
export function ensureGoalMcpServer<T>(
	servers: T,
	runtimeSupportsMcp: boolean,
	isNativeGoalCli: boolean,
): T {
	if (!runtimeSupportsMcp || isNativeGoalCli) return servers;
	if (process.env.GOAL_MCP_AUTO_WIRE === "false") return servers;
	if (!Array.isArray(servers)) return servers;
	const hasGoal = servers.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const e = entry as Record<string, unknown>;
		const name = typeof e.name === "string" ? e.name.toLowerCase() : "";
		const url = typeof e.url === "string" ? e.url : "";
		return /goal/.test(name) || url.includes("workflow-mcp-server");
	});
	if (hasGoal) return servers;
	return [
		...servers,
		{
			name: "wfb_goal",
			transport: "streamable_http",
			url: GOAL_MCP_SERVER_URL,
		},
	] as T;
}

/**
 * Stamp the workflow-builder session id into the goal MCP server entry's headers
 * so the goal tools resolve which session they act on. Scoped to the goal MCP
 * entry (matched by name ~goal or URL ~workflow-mcp-server) so we don't leak the
 * session id to third-party MCP servers.
 */
export function stampGoalMcpSessionHeader<T>(servers: T, sessionId: string): T {
	if (!Array.isArray(servers)) return servers;
	return servers.map((entry) => {
		if (!entry || typeof entry !== "object") return entry;
		const e = entry as Record<string, unknown>;
		const name = typeof e.name === "string" ? e.name.toLowerCase() : "";
		const url = typeof e.url === "string" ? e.url : "";
		const isGoalServer = /goal/.test(name) || url.includes("workflow-mcp-server");
		if (!isGoalServer) return entry;
		const headers = {
			...((e.headers as Record<string, unknown> | undefined) ?? {}),
			"X-Wfb-Session-Id": sessionId,
		};
		return { ...e, headers };
	}) as T;
}
