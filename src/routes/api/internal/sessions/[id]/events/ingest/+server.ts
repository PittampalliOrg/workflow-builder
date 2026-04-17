import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { appendEvent } from "$lib/server/sessions/events";
import { updateSessionStatus } from "$lib/server/sessions/registry";

/**
 * Internal endpoint called by `dapr-agent-py`'s session_workflow to persist a
 * CMA-shape session event. Body:
 *   { type: string, data: object, sourceEventId?: string }
 *
 * Server-side assigns the monotonic sequence via `appendEvent`. Concurrent
 * writers serialize via the unique constraint on (session_id, sequence).
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
	const envelope = await appendEvent(params.id, {
		type,
		data,
		sourceEventId,
	});

	// Mirror status events onto the sessions row so list-page filters and
	// the "terminated" UI state work without having to scan event history.
	if (type === "session.status_running") {
		await updateSessionStatus(params.id, "running");
	} else if (type === "session.status_idle") {
		const stopReasonData =
			data && typeof data.stop_reason === "object"
				? (data.stop_reason as { type?: string; event_ids?: unknown })
				: null;
		const t = String(stopReasonData?.type ?? "end_turn");
		const normalizedType =
			t === "end_turn" || t === "requires_action" || t === "retries_exhausted"
				? (t as "end_turn" | "requires_action" | "retries_exhausted")
				: "end_turn";
		await updateSessionStatus(params.id, "idle", {
			stopReason: stopReasonData
				? {
						type: normalizedType,
						event_ids: Array.isArray(stopReasonData.event_ids)
							? (stopReasonData.event_ids as unknown[]).filter(
									(v): v is string => typeof v === "string",
								)
							: undefined,
					}
				: null,
		});
	} else if (type === "session.status_terminated") {
		await updateSessionStatus(params.id, "terminated", {
			markCompleted: true,
		});
	} else if (type === "session.status_rescheduled") {
		await updateSessionStatus(params.id, "rescheduling");
	}

	return json({ event: envelope });
};
