import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getTeamView } from "$lib/server/teams/team-view";
import { authorizeTeamActionRequest } from "../team-action-principal";

/**
 * GET /api/internal/team/[teamId] — the team's members + tasks (the data the
 * session-detail team panel renders). Internal-token gated for tooling/tests;
 * the UI uses the authed public endpoint at /api/v1/sessions/[id]/team.
 */
export const GET: RequestHandler = async ({ params, request }) => {
  const authorization = await authorizeTeamActionRequest(
    request,
    params.teamId,
  );
  if (!authorization.ok)
    return error(authorization.status, authorization.error);
	const view = await getTeamView(params.teamId);
	if (!view) return error(404, "team not found");
	return json(view);
};
