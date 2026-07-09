import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getTeamView } from "$lib/server/teams/team-view";

/**
 * GET /api/internal/team/[teamId] — the team's members + tasks (the data the
 * session-detail team panel renders). Internal-token gated for tooling/tests;
 * the UI uses the authed public endpoint at /api/v1/sessions/[id]/team.
 */
export const GET: RequestHandler = async ({ params, request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const view = await getTeamView(params.teamId);
	if (!view) return error(404, "team not found");
	return json(view);
};
