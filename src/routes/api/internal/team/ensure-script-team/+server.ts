import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import { defaultTeamTokenBudget } from "$lib/server/teams/team-budget";

/**
 * POST /api/internal/team/ensure-script-team  { executionId, name? }
 *
 * Idempotent provisioning for a SCRIPT-LED team ("the script is the lead"):
 * derives the deterministic identities
 *   teamId        = team-<executionId>
 *   leadSessionId = dsw-team-lead-<executionId>   (a plain anchor sessions row)
 * creates the lead anchor (+ the synthetic `script-team-lead` agent the
 * sessions.agent_id FK requires), the team row (lead pre-registered as member),
 * and ADOPTS the script's execution as the team's container run (teammates
 * spawned afterwards roll up under the dynamic-script run — no synthetic
 * team-run execution). Called by the orchestrator's execute_team_op activity
 * before every op, so ordering is never a concern.
 *
 * Returns { teamId, leadSessionId }.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const body = (await request.json().catch(() => ({}))) as {
		executionId?: string;
		name?: string;
		/** Optional team-wide token budget (input+output across all members). */
		tokenBudget?: number;
	};
	if (!body.executionId || !body.executionId.trim()) {
		return error(400, "executionId is required");
	}
	const executionId = body.executionId.trim();
	const teamId = `team-${executionId}`;
	const leadSessionId = `dsw-team-lead-${executionId}`.slice(0, 64);

	const store = getApplicationAdapters().teamStore;
	const ctx = await store.getExecutionContext(executionId);
	if (!ctx) return error(404, `execution ${executionId} not found`);
	if (!ctx.projectId) {
		// teams.project_id is NOT NULL — team scripts need a project-scoped run.
		return error(
			400,
			"execution has no project: team primitives require a project-scoped workflow",
		);
	}

	await store.ensureScriptLeadSession({
		sessionId: leadSessionId,
		userId: ctx.userId,
		projectId: ctx.projectId,
		executionId,
		title: body.name ? `team:script-lead (${body.name})` : "team:script-lead",
	});
	const tokenBudget =
		typeof body.tokenBudget === "number" && Number.isFinite(body.tokenBudget) && body.tokenBudget > 0
			? Math.trunc(body.tokenBudget)
			: defaultTeamTokenBudget();
	await store.ensureTeam({
		teamId,
		leadSessionId,
		projectId: ctx.projectId,
		name: body.name ?? `team-${executionId.slice(0, 8)}`,
		tokenBudget,
	});
	// Adopt the script's execution as the container (idempotent; only sets when
	// unset — getTeamExecutionId short-circuit lives in ensureTeamRunExecution,
	// here we simply stamp directly since the team was just ensured).
	const existing = await store.getTeamExecutionId(teamId);
	if (!existing) await store.setTeamExecutionId(teamId, executionId);

	return json({ ok: true, teamId, leadSessionId });
};
