import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { deliverTeamMessages } from "$lib/server/teams/team-delivery";

/**
 * POST /api/internal/team/message-deliver — Dapr pub/sub subscriber for the
 * `workflow.team-message` topic (stacks Subscription-team-message.yaml on
 * workflow-triggers-pubsub). One message per injectTeamMessage publish:
 * `{ recipientSessionId, sourceEventId, kind }` (CloudEvent-wrapped by Dapr).
 *
 * Delegates to deliverTeamMessages (liveness → wake suspended/reaped runtime →
 * atomic claim → raise). Response contract:
 *   {status:"SUCCESS"} → ack       (delivered, or a terminal/dropped recipient)
 *   {status:"RETRY"} / 5xx → NACK  (JetStream redelivers: ackWait 60s ×
 *                                   maxDeliver 30 ≈ a 30-minute wake budget)
 * The handler is bounded (< ~45s worst case: one 40s readiness wait) so it
 * always answers inside the 60s ackWait. Redeliveries are safe: the atomic
 * event claim collapses duplicates (a raced delivery claims zero rows).
 * After maxDeliver exhaustion the durable session_events rows remain and the
 * next message/nudge to the same session re-flushes them (batch claim).
 */
export const POST: RequestHandler = async ({ request }) => {
	let evt: { recipientSessionId?: string } = {};
	try {
		const body = (await request.json()) as Record<string, unknown>;
		// Dapr wraps the payload in a CloudEvent; raw JSON arrives in tests.
		evt = (body.data ?? body) as typeof evt;
	} catch {
		return json({ status: "SUCCESS" }); // malformed — never poison the stream
	}
	if (!evt.recipientSessionId || typeof evt.recipientSessionId !== "string") {
		console.warn("[team-message-deliver] no recipientSessionId in payload — acking");
		return json({ status: "SUCCESS" });
	}
	try {
		const outcome = await deliverTeamMessages(evt.recipientSessionId);
		// Log EVERY delivery (not just failures): the one delivery we lost on dev
		// was acked with zero trace, which made the triage blind. One line per
		// message is cheap and makes the pubsub hop observable end-to-end.
		console.info(
			`[team-message-deliver] recipient=${evt.recipientSessionId} outcome=${outcome}`,
		);
		if (outcome === "retry") {
			// HTTP 500 is the unambiguous NACK for every pubsub component; the
			// 2xx+{"status":"RETRY"} body contract proved unreliable on the
			// JetStream component (acked without redelivery — observed on dev).
			return json({ status: "RETRY" }, { status: 500 });
		}
		return json({ status: "SUCCESS" });
	} catch (err) {
		console.error("[team-message-deliver] delivery failed:", err);
		return json({ status: "RETRY" }, { status: 500 });
	}
};

/** Dapr's subscription probe expects a 2xx on OPTIONS (same as the tick route). */
export const OPTIONS = () => new Response(null, { status: 200 });
