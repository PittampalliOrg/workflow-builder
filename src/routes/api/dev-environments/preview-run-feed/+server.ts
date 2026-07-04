import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { getApplicationAdapterConfig } from "$lib/server/application/config";

/**
 * SSE feed of live workflow runs across all active Tier-2 previews (E1).
 *
 * Read-only aggregation off the shared host NATS. Flag-gated
 * (`PREVIEW_RUN_FEED_ENABLED`, default off) — 404 when disabled so the feature
 * is invisible until enabled.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!getApplicationAdapterConfig().previewRunFeedEnabled) {
		return error(404, "Preview run feed is disabled");
	}

	const stream = getApplicationAdapters().previewRunFeed.createEventStream();

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-store, must-revalidate",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
};
