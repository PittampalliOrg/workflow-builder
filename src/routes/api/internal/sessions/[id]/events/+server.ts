import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { validateInternalToken } from "$lib/server/internal-auth";
import { listEvents } from "$lib/server/sessions/events";

/**
 * Internal endpoint that returns a positional window of session events for
 * Anthropic's `getEvents()` pattern. Used by dapr-agent-py's
 * `read_session_events` built-in tool when the agent runs under
 * `contextStrategy == "event_log"` — instead of compacting messages
 * irreversibly, the brain slices the durable event log positionally.
 *
 * Query params:
 *   - afterSequence (optional): return events with sequence strictly greater
 *     than this cursor.
 *   - limit (optional, default 100, max 500): max events to return.
 *
 * Auth: internal service token only. Not exposed to end users — the
 * user-facing equivalent is `/api/v1/sessions/[id]/events` (session-scoped).
 *
 * Durability: this is a read of the projection table `session_events`. The
 * source of truth remains Dapr's durable-task event log via
 * `session_workflow`; this endpoint is a convenience read path.
 */
export const GET: RequestHandler = async ({ params, request, url }) => {
	if (!validateInternalToken(request)) return error(401, "Unauthorized");

	const sessionId = params.id;
	if (!sessionId) return error(400, "session id is required");

	const afterSequenceRaw = url.searchParams.get("afterSequence");
	const afterSequence =
		afterSequenceRaw !== null && afterSequenceRaw !== ""
			? Number.parseInt(afterSequenceRaw, 10)
			: undefined;
	if (afterSequence !== undefined && Number.isNaN(afterSequence)) {
		return error(400, "afterSequence must be an integer");
	}

	const limitRaw = url.searchParams.get("limit");
	const limitParsed =
		limitRaw !== null && limitRaw !== "" ? Number.parseInt(limitRaw, 10) : 100;
	if (Number.isNaN(limitParsed) || limitParsed < 1) {
		return error(400, "limit must be a positive integer");
	}
	const limit = Math.min(limitParsed, 500);

	const events = await listEvents(sessionId, { afterSequence, limit });

	return json({
		sessionId,
		events: events.map((e) => ({
			sequence: e.sequence,
			type: e.type,
			data: e.data,
			sourceEventId: e.sourceEventId ?? null,
			createdAt: e.createdAt,
		})),
		nextAfterSequence:
			events.length > 0 ? events[events.length - 1].sequence : afterSequence,
		returned: events.length,
		limit,
	});
};
