import { randomUUID } from "node:crypto";
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { authorizeTeamActionRequest } from "../../team-action-principal";

/**
 * POST /api/internal/team/[teamId]/broadcast  { fromSessionId?, content }
 *
 * Team-wide broadcast. Publishes ONE message to the `workflow.team-broadcast`
 * pub/sub topic (NATS JetStream, via the EventBus) — a Dapr-idiomatic, decoupled,
 * at-least-once distribution layer. The `Subscription-team-broadcast` delivery
 * route (/api/internal/team/broadcast-deliver) receives it and fans out to each
 * live teammate over the existing external-event path (injectTeamMessage), so
 * delivery, `session_events` persistence, UI rendering, and the deterministic
 * `sourceEventId` dedup are all preserved. See docs/agent-teams-phase1.md.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as {
		fromSessionId?: string;
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
	if (!body.content) return error(400, "content is required");

	const broadcastId = randomUUID();
	await getApplicationAdapters().eventBus.publish("workflow.team-broadcast", {
		teamId: params.teamId,
    fromSessionId: authorization.principal.sessionId,
		content: body.content,
		broadcastId,
	});
	return json({ ok: true, published: true, broadcastId });
};
