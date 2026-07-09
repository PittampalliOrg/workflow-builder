import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { db } from "$lib/server/db";
import { claimNextTask, type TeamTasksDb } from "$lib/server/teams/team-tasks";

/**
 * POST /api/internal/team/[teamId]/claim  { sessionId }
 *
 * The single home of the atomic claim (FOR UPDATE SKIP LOCKED, dependency-aware).
 * The MCP `claim_task` tool routes here so the claim SQL lives in one place.
 * Returns { task } — the claimed task, or null when nothing is claimable.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const body = (await request.json().catch(() => ({}))) as { sessionId?: string };
	if (!body.sessionId) return error(400, "sessionId is required");
	const task = await claimNextTask(db as unknown as TeamTasksDb, {
		teamId: params.teamId,
		sessionId: body.sessionId,
	});
	return json({ task });
};
