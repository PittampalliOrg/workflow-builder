import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getTeamLiveActivity } from "$lib/server/teams/team-repo";

/**
 * GET /api/v1/teams/[teamId]/live — the Live tab's team board: the latest
 * classifiable event per member (what is everyone doing RIGHT NOW) plus a
 * recent merged event stream across every member session. Two indexed
 * queries; polled ~3s while a run is active. `{members: [], stream: []}`
 * for unknown teams (safe probe, same posture as the team view).
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const live = await getTeamLiveActivity(params.teamId, 40);
	return json({
		members: live.members.map((m) => ({
			name: m.name,
			role: m.role,
			status: m.status,
			sessionId: m.session_id,
			event: m.event_type
				? {
						type: m.event_type,
						tool: m.tool_name,
						origin: m.origin,
						from: m.from_agent,
						preview: m.preview,
						at: m.event_at,
					}
				: null,
		})),
		stream: live.stream.map((e) => ({
			member: e.name,
			sessionId: e.session_id,
			type: e.event_type,
			tool: e.tool_name,
			origin: e.origin,
			from: e.from_agent,
			preview: e.preview,
			at: e.event_at,
		})),
	});
};
