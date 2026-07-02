import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
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
	const { workflowData } = getApplicationAdapters();
	const session = await workflowData.getSessionEventStreamSnapshot({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
	});
	if (!session) return error(404, "Session not found");
	const events = await workflowData.listSessionEvents(params.id, {
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
	}
	const { workflowData } = getApplicationAdapters();
	const result = await workflowData.appendSessionUserEvents({
		sessionId: params.id,
		projectId: locals.session.projectId ?? null,
		events,
	});
	if (result.status === "not_found") return error(404, "Session not found");
	appended.push(...result.events);
	return json({ events: appended });
};

function isUserEvent(value: unknown): value is UserEvent {
	if (!value || typeof value !== "object") return false;
	const t = (value as { type?: unknown }).type;
	// NOTE: `user.interrupt` is intentionally NOT accepted here — interrupts must go
	// through the vetted lifecycle controller (POST .../control/interrupt →
	// stopDurableRun mode:interrupt), which is scope-checked + fail-closed. This
	// route is for genuine user input (message / tool confirmation) only.
	return (
		t === "user.message" ||
		t === "user.tool_confirmation" ||
		t === "user.custom_tool_result"
	);
}
