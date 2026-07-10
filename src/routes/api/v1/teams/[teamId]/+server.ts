import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getTeamView } from "$lib/server/teams/team-view";

/**
 * GET /api/v1/teams/[teamId] — the team's members + tasks, for the team-run
 * panel on the run-detail page. Returns { team: null, ... } when the team
 * doesn't exist.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const view = await getTeamView(params.teamId);
	return json(view ?? { team: null, members: [], tasks: [] });
};
