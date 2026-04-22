import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { listEvents, sendUserEvent } from "$lib/server/sessions/events";
import { getSession } from "$lib/server/sessions/registry";
import { raiseSessionUserEvents } from "$lib/server/sessions/spawn";
import type { UserEvent } from "$lib/types/sessions";

export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const afterSeqParam = url.searchParams.get("afterSequence");
	const afterSequence = afterSeqParam
		? Number.parseInt(afterSeqParam, 10)
		: undefined;
	const limitParam = url.searchParams.get("limit");
	const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
	// Preview defaults on. Callers that want full payloads pass `?preview=0`.
	// The single-event route (GET /events/[eventId]) always returns full.
	const previewParam = url.searchParams.get("preview");
	const preview = previewParam === "0" || previewParam === "false" ? false : true;
	const events = await listEvents(params.id, {
		afterSequence: Number.isFinite(afterSequence) ? afterSequence : undefined,
		limit: Number.isFinite(limit) ? limit : undefined,
		preview,
	});
	return json({ events });
};

/**
 * Batch-append user events. Accepts the same wire shape as CMA:
 *   { events: [{type: 'user.message', content: [...]}, ...] }
 *
 * Events are appended in order; each gets a monotonic sequence. The agent
 * picks them up via `ctx.wait_for_external_event`; a follow-up write from
 * the workflow will set `processedAt` once it consumes them.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const session = await getSession(params.id);
	if (!session) return error(404, "Session not found");

	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const events = Array.isArray(body.events) ? (body.events as UserEvent[]) : [];
	if (events.length === 0) return error(400, "events array is required");

	const appended: unknown[] = [];
	for (const event of events) {
		if (!isUserEvent(event)) {
			return error(400, `unknown event type: ${(event as { type?: string }).type ?? ""}`);
		}
		appended.push(await sendUserEvent(params.id, event));
	}
	// Raise the Dapr external event that unblocks session_workflow's
	// `wait_for_external_event("session.user_events")`. Failure is non-fatal:
	// the DB append already succeeded, and a subsequent reconnect + new
	// message will re-deliver via the next external event.
	try {
		await raiseSessionUserEvents(params.id, events);
	} catch (err) {
		console.warn("[sessions] raiseSessionUserEvents failed:", err);
	}
	return json({ events: appended });
};

function isUserEvent(value: unknown): value is UserEvent {
	if (!value || typeof value !== "object") return false;
	const t = (value as { type?: unknown }).type;
	return (
		t === "user.message" ||
		t === "user.interrupt" ||
		t === "user.tool_confirmation" ||
		t === "user.custom_tool_result"
	);
}
