import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getMemberBySession, listMembers } from "$lib/server/teams/team-repo";
import { injectTeamMessage } from "$lib/server/teams/team-messaging";

/**
 * Dapr pub/sub delivery route for team broadcasts (topic `workflow.team-broadcast`,
 * wired by stacks `Subscription-team-broadcast.yaml`). A single publish from the
 * broadcast endpoint fans out here to every live teammate over the existing
 * external-event path (injectTeamMessage) — same deterministic sourceEventId
 * (`team-broadcast:<broadcastId>:<sessionId>`), same session_events persistence
 * + UI + dedup. Reachable only via the in-cluster daprd subscription.
 *
 * IDEMPOTENCY: JetStream is at-least-once. The per-recipient sourceEventId is
 * deterministic, so a redelivery is swallowed by the (session_id, source_event_id)
 * unique index. We ALWAYS ack (`{status:"SUCCESS"}`) so a poison message can't
 * wedge the subscription (JetStream max-deliver → DLQ governs, not an infinite loop).
 */
export const POST: RequestHandler = async ({ request }) => {
	let evt: {
		teamId?: string;
		fromSessionId?: string | null;
		content?: string;
		broadcastId?: string;
	} = {};
	try {
		const body = (await request.json()) as Record<string, unknown>;
		// Dapr wraps the payload in a CloudEvent; accept both wrapped + raw.
		evt = (body.data ?? body) as typeof evt;
	} catch {
		return json({ status: "SUCCESS" }); // malformed — ack + drop
	}

	try {
		if (evt.teamId && evt.content && evt.broadcastId) {
			const members = await listMembers(evt.teamId);
			const from = evt.fromSessionId
				? await getMemberBySession(evt.fromSessionId)
				: null;
			for (const m of members) {
				if (m.session_id === evt.fromSessionId) continue;
				if (m.status === "shutdown") continue;
				await injectTeamMessage({
					recipientSessionId: m.session_id,
					fromName: from?.name ?? "lead",
					content: evt.content,
					kind: "team-broadcast",
					sourceEventId: `team-broadcast:${evt.broadcastId}:${m.session_id}`,
				});
			}
		}
	} catch (err) {
		// Never NACK on a handler error — ack so JetStream redelivery/DLQ governs.
		console.error(
			"[team-broadcast] delivery failed:",
			err instanceof Error ? err.message : err,
		);
	}
	return json({ status: "SUCCESS" });
};
