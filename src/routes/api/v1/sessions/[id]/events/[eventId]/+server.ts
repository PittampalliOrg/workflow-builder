import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getEvent } from "$lib/server/sessions/events";

/**
 * Fetch a single session event with the full (un-stripped) payload. The list
 * endpoint + SSE stream default to preview-only shape; the debug panel uses
 * this route when the user clicks "Load full payload".
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const envelope = await getEvent(params.id, params.eventId);
	if (!envelope) return error(404, "Event not found");
	return json({ event: envelope });
};
