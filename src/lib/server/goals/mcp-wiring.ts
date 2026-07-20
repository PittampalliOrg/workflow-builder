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
