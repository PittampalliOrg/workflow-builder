import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getTeamViewForSession } from "$lib/server/teams/team-view";

/**
 * GET /api/v1/sessions/[id]/team — the team (members + tasks) this session
 * belongs to, for the session-detail team panel. Returns { team: null } when
 * the session is not part of a team.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const view = await getTeamViewForSession(params.id);
	return json(view ?? { team: null, members: [], tasks: [] });
};
