import { randomUUID } from "node:crypto";
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  getMemberByName,
  getMemberBySession,
} from "$lib/server/teams/team-repo";
import { injectTeamMessage } from "$lib/server/teams/team-messaging";
import { authorizeTeamActionRequest } from "../../team-action-principal";

/**
 * POST /api/internal/team/[teamId]/message  { fromSessionId?, to, content }
 *
 * Point-to-point teammate message. Reuses the goal-loop delivery path
 * (appendSessionEvent + raiseSessionUserEvents) with a deterministic
 * sourceEventId so Dapr replay / dual ingest dedupe.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as {
		fromSessionId?: string;
		to?: string;
		content?: string;
	};
  const authorization = await authorizeTeamActionRequest(
    request,
    params.teamId,
    {
      bodySessionId: body.fromSessionId,
    },
  );
  if (!authorization.ok)
    return error(authorization.status, authorization.error);
  if (!body.to || !body.content)
    return error(400, "to and content are required");

	const recipient = await getMemberByName(params.teamId, body.to);
	if (!recipient) return error(404, `no teammate '${body.to}' in this team`);
  if (recipient.status === "starting") {
    return json(
      {
        ok: false,
        state: "starting",
        retryable: true,
        message: `teammate '${body.to}' is still starting`,
      },
      { status: 409, headers: { "retry-after": "1" } },
    );
  }
  const from = await getMemberBySession(authorization.principal.sessionId);

	await injectTeamMessage({
		recipientSessionId: recipient.session_id,
		fromName: from?.name ?? "lead",
		content: body.content,
		kind: "teammate-message",
		sourceEventId: `team-msg:${randomUUID()}`,
	});
	return json({ ok: true, to: recipient.name });
};
