/**
 * Team MCP wiring — stamp team scope onto the workflow-mcp-server entry.
 *
 * The team tools live on the SAME workflow-mcp-server that hosts the goal/script
 * tools, so `ensureGoalMcpServer` already adds the server entry; we only stamp
 * the team scope headers on it (mirrors stampGoalMcpSessionHeader /
 * stampScriptGuardHeader in goals/mcp-wiring.ts):
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

export function deriveLeadTeamId(sessionId: string): string {
	return `team-${sessionId}`;
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
