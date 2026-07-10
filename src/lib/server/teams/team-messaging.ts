/**
 * Agent Teams — message delivery (publish side).
 *
 * The single entry point for every teammate/lead/idle message. Two steps:
 *
 *   1. DURABLE RECORD: append a `user.message` session event with a
 *      deterministic `sourceEventId` (exactly-once via the (session_id,
 *      source_event_id) unique index). This is the mailbox — it renders in the
 *      UI immediately and survives any runtime state.
 *   2. DELIVERY TRIGGER: publish `{recipientSessionId, sourceEventId, kind}` to
 *      the `workflow.team-message` pub/sub topic (NATS JetStream, at-least-once,
 *      maxDeliver-bounded). The subscriber (team-delivery.ts via
 *      /api/internal/team/message-deliver) wakes a suspended/reaped recipient
 *      (Sandbox replicas 0→1; the parked session_workflow survives in the task
 *      hub) and then atomically claims + raises ALL pending team-origin events.
 *
 * The old inline best-effort raise is gone: delivery — including retry, wake,
 * and the exactly-once claim — lives entirely behind the topic. Content is NOT
 * in the payload; the subscriber reads the durable rows.
 *
 * If the publish fails after the append, the message is still persisted and the
 * next publish/nudge to the same recipient flushes it (the claim is a batch).
 */

import { getApplicationAdapters } from "$lib/server/application";

export type TeamMessageKind = "teammate-message" | "team-broadcast" | "team-idle";

/** Topic carrying team message delivery triggers (subject under `workflow.>`
 * on the ORCHESTRATOR JetStream stream — see stacks Subscription-team-message). */
export const TEAM_MESSAGE_TOPIC = "workflow.team-message";

/**
 * Inject a team message into `recipientSessionId`. `sourceEventId` MUST be
 * deterministic (e.g. `team-msg:<uuid>`, `team-idle:<sid>:<seq>`) so Dapr replay
 * and dual ingest paths dedupe.
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
	// NOTE: `origin` doubles as the claim scope in claimUnraisedTeamEvents — the
	// three TeamMessageKind values are exactly the set the delivery path owns.
	const userMessage = {
		type: "user.message",
		content: [{ type: "text", text: input.content }],
		origin: input.kind,
		fromAgent: input.fromName,
	};
	await getApplicationAdapters().workflowData.appendSessionEvent(
		input.recipientSessionId,
		{
			type: "user.message",
			data: userMessage,
			processedAt: null,
			sourceEventId: input.sourceEventId,
		},
	);
	await getApplicationAdapters().eventBus.publish(TEAM_MESSAGE_TOPIC, {
		recipientSessionId: input.recipientSessionId,
		sourceEventId: input.sourceEventId,
		kind: input.kind,
	});
}
