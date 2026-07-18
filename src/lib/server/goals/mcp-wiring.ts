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

function normalizedMcpUrl(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function isTrustedWorkflowMcpServer(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const url = (entry as Record<string, unknown>).url;
  return (
    normalizedMcpUrl(url) !== "" &&
    normalizedMcpUrl(url) === normalizedMcpUrl(GOAL_MCP_SERVER_URL)
  );
}

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
  const hasGoal = servers.some(isTrustedWorkflowMcpServer);
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
export function stampGoalMcpSessionHeader<T>(
  servers: T,
  sessionId: string,
  sessionToken?: string | null,
): T {
	if (!Array.isArray(servers)) return servers;
	return servers.map((entry) => {
		if (!entry || typeof entry !== "object") return entry;
		const e = entry as Record<string, unknown>;
    if (!isTrustedWorkflowMcpServer(e)) return entry;
		const headers = {
			...((e.headers as Record<string, unknown> | undefined) ?? {}),
			"X-Wfb-Session-Id": sessionId,
      ...(sessionToken ? { "X-Wfb-Session-Token": sessionToken } : {}),
		};
		return { ...e, headers };
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
      /goal/.test(name) ||
      /script/.test(name) ||
      url.includes("workflow-mcp-server");
		if (!isWorkflowMcpServer) return entry;
		const headers = {
			...((e.headers as Record<string, unknown> | undefined) ?? {}),
			"X-Wfb-Script-Depth": "1",
		};
		return { ...e, headers };
	}) as T;
}
