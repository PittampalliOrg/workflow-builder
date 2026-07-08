/**
 * Goal MCP wiring helpers, shared by the direct-spawn path
 * (`src/lib/server/sessions/spawn.ts`) and the workflow→session bridge
 * (`/api/internal/sessions/ensure-for-workflow`). Auto-wires the goal MCP
 * server (create_goal/update_goal/get_goal) into MCP-capable, custom-loop goal
 * sessions so non-CLI agents can self-complete their goals, and stamps the
 * session id so the goal tools resolve which session they act on.
 */

export const GOAL_MCP_SERVER_URL =
	process.env.GOAL_MCP_SERVER_URL ??
	"http://workflow-mcp-server.workflow-builder.svc.cluster.local:3200/mcp";

/**
 * Auto-wire the goal MCP server into MCP-capable non-CLI sessions so goals can
 * self-complete — without the tools, a goal loop can only end via
 * budget/iteration caps or a manual pause. CLI agents intentionally do not get
 * this default server; their tool schema should contain only explicitly
 * configured MCP servers plus runtime-internal tools such as StructuredOutput.
 * Also skipped when an entry already matches the goal server or when
 * GOAL_MCP_AUTO_WIRE=false.
 */
export function ensureGoalMcpServer<T>(
	servers: T,
	runtimeSupportsMcp: boolean,
	isCliRuntime: boolean,
): T {
	if (!runtimeSupportsMcp || isCliRuntime) return servers;
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

/**
 * Recursion guard for dynamic-script runs: stamp `X-Wfb-Script-Depth: 1` on the
 * workflow-mcp-server MCP entries of a session spawned BY a dynamic-script
 * execution. The MCP server reads the header at `initialize` and suppresses the
 * `run_workflow_script` tool, so a script-spawned agent cannot recursively start
 * another script workflow. Scoped to the workflow-mcp-server entry (same matching
 * as `stampGoalMcpSessionHeader`) so the depth marker never leaks to third-party
 * MCP servers.
 */
export function stampScriptGuardHeader<T>(servers: T): T {
	if (!Array.isArray(servers)) return servers;
	return servers.map((entry) => {
		if (!entry || typeof entry !== "object") return entry;
		const e = entry as Record<string, unknown>;
		const name = typeof e.name === "string" ? e.name.toLowerCase() : "";
		const url = typeof e.url === "string" ? e.url : "";
		const isWorkflowMcpServer =
			/goal/.test(name) || /script/.test(name) || url.includes("workflow-mcp-server");
		if (!isWorkflowMcpServer) return entry;
		const headers = {
			...((e.headers as Record<string, unknown> | undefined) ?? {}),
			"X-Wfb-Script-Depth": "1",
		};
		return { ...e, headers };
	}) as T;
}
