import { randomUUID } from "node:crypto";
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getMemberBySession, listMembers } from "$lib/server/teams/team-repo";
import { injectTeamMessage } from "$lib/server/teams/team-messaging";

/**
 * POST /api/internal/team/[teamId]/broadcast  { fromSessionId?, content }
 *
 * Team-wide fan-out: deliver the message to every member except the sender.
 * Each delivery rides the same raise-event path as a point-to-point message,
 * with a per-recipient deterministic sourceEventId derived from one broadcast id.
 * (A future optimization can move the fan-out onto NATS; the delivery into each
 * live session is always the raise-event.)
 */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const body = (await request.json().catch(() => ({}))) as {
		fromSessionId?: string;
		content?: string;
	};
	if (!body.content) return error(400, "content is required");

	const members = await listMembers(params.teamId);
	const from = body.fromSessionId
		? await getMemberBySession(body.fromSessionId)
		: null;
	const broadcastId = randomUUID();

	let delivered = 0;
	for (const m of members) {
		if (m.session_id === body.fromSessionId) continue;
		if (m.status === "shutdown") continue;
		await injectTeamMessage({
			recipientSessionId: m.session_id,
			fromName: from?.name ?? "lead",
			content: body.content,
			kind: "team-broadcast",
			sourceEventId: `team-broadcast:${broadcastId}:${m.session_id}`,
		});
		delivered++;
	}
	return json({ ok: true, delivered });
};
