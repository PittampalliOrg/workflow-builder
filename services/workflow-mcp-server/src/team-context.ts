/**
 * Team request context
 *
 * The team tools (spawn_teammate/send_message/create_task/claim_task/...) are
 * scoped to the authenticated Workflow Builder session and the team carried in
 * its BFF-signed capabilities. The AsyncLocalStorage value below is populated
 * only after that credential has been resolved. Legacy header parsing remains
 * exported for staged-rollout tests and older callers, but is not used as an
 * authorization source by the current MCP request handler.
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

export type TeamRole = "none" | "lead" | "member";

/**
 * Resolve the session's team role from request headers (used at MCP init to
 * decide which team tools to register):
 *   • no X-Wfb-Team-Id            → "none"   (not in a team; register NO team tools)
 *   • X-Wfb-Team-Id, no depth     → "lead"   (register ALL team tools)
 *   • X-Wfb-Team-Id + Team-Depth  → "member" (worker tools only — no spawn_teammate/
 *                                              shutdown_teammate; the nesting guard)
 */
export function teamRoleFromHeaders(
	headers: http.IncomingHttpHeaders,
): TeamRole {
	const teamId = headers["x-wfb-team-id"];
	if (!teamId || String(teamId).trim().length === 0) return "none";
	const depth = headers["x-wfb-team-depth"];
	const isMember =
		depth !== undefined && depth !== null && String(depth).length > 0;
	return isMember ? "member" : "lead";
}
