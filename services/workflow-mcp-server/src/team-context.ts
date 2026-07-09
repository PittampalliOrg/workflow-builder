/**
 * Team request context
 *
 * The team tools (spawn_teammate/send_message/create_task/claim_task/...) are
 * scoped to (a) the caller's workflow-builder session (== the acting agent, via
 * X-Wfb-Session-Id, already carried by the goal context) and (b) the team the
 * caller belongs to (X-Wfb-Team-Id). The BFF stamps X-Wfb-Team-Id into the team
 * MCP server entry's headers at spawn time for every team member (lead included).
 *
 * X-Wfb-Team-Depth is the nesting guard, mirroring the script tools'
 * X-Wfb-Script-Depth: when present it means the caller is itself a teammate
 * spawned by the team machinery, so the team tools are suppressed — teammates
 * cannot spawn their own teams (Claude Code forbids nested teams too).
 * (Same AsyncLocalStorage pattern as goal-context.ts.)
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type http from "node:http";

export type TeamRequestContext = {
	teamId?: string | null;
};

const teamContext = new AsyncLocalStorage<TeamRequestContext>();

export function runWithTeamContext<T>(
	context: TeamRequestContext,
	fn: () => T,
): T {
	return teamContext.run(context, fn);
}

export function currentTeamId(): string | null {
	const teamId = teamContext.getStore()?.teamId?.trim();
	return teamId ? teamId : null;
}

/** True when the request carries X-Wfb-Team-Depth (a teammate) — suppress team tools. */
export function shouldSuppressTeamTools(
	headers: http.IncomingHttpHeaders,
): boolean {
	const depth = headers["x-wfb-team-depth"];
	return depth !== undefined && depth !== null && String(depth).length > 0;
}
