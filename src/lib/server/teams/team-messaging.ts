/**
 * Agent Teams — message delivery.
 *
 * The single delivery path for every teammate/lead/idle message, mirroring the
 * goal-loop continuation exactly: append a `user.message` session event with a
 * deterministic `sourceEventId` (exactly-once via the (session_id,
 * source_event_id) unique index), then raise it into the recipient's live
 * session_workflow via `session.user_events`. This is the Dapr-native external-
 * event mailbox + the dedup layer Dapr itself omits.
 *
 * Point-to-point (send_message) and idle notices use this directly; broadcast
 * fans it out across members. (A future optimization can move broadcast onto
 * NATS, but the delivery into a live session is always raise-event.)
 */

import { appendSessionEvent } from "$lib/server/application/adapters/session-events";
import { raiseSessionUserEvents } from "$lib/server/sessions/spawn";

export type TeamMessageKind = "teammate-message" | "team-broadcast" | "team-idle";

/**
 * Inject a team message into `recipientSessionId`. `sourceEventId` MUST be
 * deterministic (e.g. `team-msg:<uuid>`, `team-idle:<sid>:<seq>`) so Dapr replay
 * and dual ingest paths dedupe. Returns false if the recipient session is gone.
 */
export async function injectTeamMessage(input: {
	recipientSessionId: string;
	fromName: string;
	content: string;
	kind: TeamMessageKind;
	sourceEventId: string;
}): Promise<void> {
	// Same shape the goal loop uses; `origin`/`fromAgent` let the UI style it and
	// the agent ignores the extra fields. Content is the standard block array.
	const userMessage = {
		type: "user.message",
		content: [{ type: "text", text: input.content }],
		origin: input.kind,
		fromAgent: input.fromName,
	};
	await appendSessionEvent(input.recipientSessionId, {
		type: "user.message",
		data: userMessage,
		processedAt: null,
		sourceEventId: input.sourceEventId,
	});
	await raiseSessionUserEvents(input.recipientSessionId, [userMessage]);
}
