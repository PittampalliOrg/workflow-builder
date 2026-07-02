import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { validateInternalToken } from "$lib/server/internal-auth";
import { cleanupSessionSandbox } from "$lib/server/sandboxes/provision";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Internal endpoint called by `dapr-agent-py`'s session_workflow to persist a
 * CMA-shape session event. Body:
 *   { type: string, data: object, sourceEventId?: string }
 *
 * Server-side persistence assigns the monotonic sequence. Concurrent writers
 * serialize via the unique constraint on (session_id, sequence).
 *
 * This is the durability + replay backing for the SSE stream — NATS pub/sub
 * is the real-time transport; this endpoint persists for reconnect replay
 * and for clients that never subscribed.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const type = typeof body.type === "string" ? body.type : "";
	if (!type) return error(400, "type is required");
	const data =
		body.data && typeof body.data === "object"
			? (body.data as Record<string, unknown>)
			: {};
	const sourceEventId =
		typeof body.sourceEventId === "string" ? body.sourceEventId : null;
	// Producer-Id triple stamped by dapr-agent-py event_publisher on every
	// envelope (Tier 3). Persisted for provenance + joined with agents.slug
	// for "events by agent X" aggregation.
	const producerId =
		typeof body.producerId === "string" && body.producerId ? body.producerId : null;
	const producerEpoch =
		typeof body.producerEpoch === "string" && body.producerEpoch
			? body.producerEpoch
			: null;
	const { workflowData } = getApplicationAdapters();
	const result = await workflowData.ingestSessionEvent({
		sessionId: params.id,
		type,
		data,
		sourceEventId,
		producerId,
		producerEpoch,
	});

	if (result.cleanupSessionSandbox) {
		void cleanupSessionSandbox(params.id);
	}

	return json({ event: result.event });
};
