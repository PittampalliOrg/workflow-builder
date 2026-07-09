import { randomUUID } from "node:crypto";
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { getMemberByName, getMemberBySession } from "$lib/server/teams/team-repo";
import { injectTeamMessage } from "$lib/server/teams/team-messaging";

/**
 * POST /api/internal/team/[teamId]/message  { fromSessionId?, to, content }
 *
 * Point-to-point teammate message. Reuses the goal-loop delivery path
 * (appendSessionEvent + raiseSessionUserEvents) with a deterministic
 * sourceEventId so Dapr replay / dual ingest dedupe.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const body = (await request.json().catch(() => ({}))) as {
		fromSessionId?: string;
		to?: string;
		content?: string;
	};
	if (!body.to || !body.content) return error(400, "to and content are required");

	const recipient = await getMemberByName(params.teamId, body.to);
	if (!recipient) return error(404, `no teammate '${body.to}' in this team`);
	const from = body.fromSessionId
		? await getMemberBySession(body.fromSessionId)
		: null;

	await injectTeamMessage({
		recipientSessionId: recipient.session_id,
		fromName: from?.name ?? "lead",
		content: body.content,
		kind: "teammate-message",
		sourceEventId: `team-msg:${randomUUID()}`,
	});
	return json({ ok: true, to: recipient.name });
};
