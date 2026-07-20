/**
 * Team MCP compatibility wiring for the staged server rollout.
 *
 * The current server derives team authority from BFF-signed session claims.
 * These unsigned headers grant no capability; they remain temporarily so older
 * MCP pods keep the same nesting behavior while BFF and MCP images roll out in
 * phases:
 *   • X-Wfb-Team-Id   — which team the session acts in (lead + teammates)
 *   • X-Wfb-Team-Depth — teammates only; suppresses the team tools so a teammate
 *                        cannot spawn a nested team (Claude Code forbids that too).
 *
 * A lead's team id is DERIVED from its own session id (team-<sessionId>), so a
 * lead has the team tools available before any team row exists; `ensureTeam`
 * creates the row lazily on the first spawn_teammate. Teammates carry the lead's
 * team id (resolved from their team_members row) + the depth guard.
 *
 * A lead opts in PER-AGENT via `agentConfig.teamsEnabled` (so only agents meant
 * to lead teams gain the 8 tools). Teammates (a team_members row exists) are
 * always stamped regardless. `TEAM_MCP_AUTO_WIRE=true` remains an optional global
 * override (default off) for fleet-wide enablement.
 */

/**
 * The Workflow MCP server that hosts the team tools (claim_task / update_task /
 * publish_knowledge / …). Previously teammates reached it via the goal MCP
 * entry that `ensureGoalMcpServer` auto-wired; that entry was removed with the
 * goal tools, so the team path now injects its own entry.
 */
export const WORKFLOW_MCP_SERVER_URL =
	process.env.WORKFLOW_MCP_SERVER_URL ??
	process.env.GOAL_MCP_SERVER_URL ??
	"http://workflow-mcp-server.workflow-builder.svc.cluster.local:3200/mcp";

function normalizedUrl(value: unknown): string {
	return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function hasWorkflowMcpEntry(servers: unknown[]): boolean {
	return servers.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const url = (entry as Record<string, unknown>).url;
		return (
			normalizedUrl(url).includes("workflow-mcp-server") ||
			normalizedUrl(url) === normalizedUrl(WORKFLOW_MCP_SERVER_URL)
		);
	});
}

export function deriveLeadTeamId(sessionId: string): string {
	return `team-${sessionId}`;
}

/**
 * Inject the Workflow MCP server entry (`wfb_team`) so team-capable sessions
 * can reach the team tools. Same gate as `stampTeamMcpHeaders`: teammates
 * always, opted-in leads (`agentConfig.teamsEnabled`), or the global override.
 * Skipped when a workflow-mcp-server entry is already present (the header
 * stamper then decorates that one). CLI-only exclusion is handled by callers.
 */
export function ensureTeamMcpServer<T>(
	servers: T,
	opts: { isTeammate: boolean; teamsEnabled?: boolean; isCliRuntime?: boolean },
): T {
	// CLI runtimes do not receive the platform-injected Workflow MCP entry
	// (matches the prior goal-server behavior; CLI agents configure MCP via
	// their own adapter).
	if (opts.isCliRuntime) return servers;
	const enabled =
		opts.isTeammate ||
		opts.teamsEnabled === true ||
		process.env.TEAM_MCP_AUTO_WIRE === "true";
	if (!enabled) return servers;
	if (!Array.isArray(servers)) return servers;
	if (hasWorkflowMcpEntry(servers)) return servers;
	return [
		...servers,
		{
			name: "wfb_team",
			transport: "streamable_http",
			url: WORKFLOW_MCP_SERVER_URL,
		},
	] as T;
}

export function stampTeamMcpHeaders<T>(
	servers: T,
	opts: { teamId: string; isTeammate: boolean; teamsEnabled?: boolean },
): T {
	// Stamp when: this is a teammate (always), the agent opted in
	// (agentConfig.teamsEnabled), or the global override is on.
	const enabled =
		opts.isTeammate ||
		opts.teamsEnabled === true ||
		process.env.TEAM_MCP_AUTO_WIRE === "true";
	if (!enabled) return servers;
	if (!Array.isArray(servers)) return servers;
	return servers.map((entry) => {
		if (!entry || typeof entry !== "object") return entry;
		const e = entry as Record<string, unknown>;
		const name = typeof e.name === "string" ? e.name.toLowerCase() : "";
		const url = typeof e.url === "string" ? e.url : "";
		const isWfbMcp =
			/goal/.test(name) ||
			/team/.test(name) ||
			url.includes("workflow-mcp-server");
		if (!isWfbMcp) return entry;
		const headers: Record<string, unknown> = {
			...((e.headers as Record<string, unknown> | undefined) ?? {}),
			"X-Wfb-Team-Id": opts.teamId,
		};
		if (opts.isTeammate) headers["X-Wfb-Team-Depth"] = "1";
		return { ...e, headers };
	}) as T;
}
