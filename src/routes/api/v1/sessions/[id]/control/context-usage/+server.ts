import { error, json } from "@sveltejs/kit";
import { eq, sql } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import { sessionEvents } from "$lib/server/db/schema";
import { getSession } from "$lib/server/sessions/registry";

/**
 * Synchronous read: token usage + event stats. Used by the usage panel in
 * the session UI to estimate how close we are to the model's context window.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!db) return error(503, "Database not configured");
	const session = await getSession(params.id);
	if (!session) return error(404, "Session not found");

	const [{ eventCount, totalBytes, turns }] = await db
		.select({
			eventCount: sql<number>`count(*)`,
			totalBytes: sql<number>`coalesce(sum(length(data::text)), 0)`,
			turns: sql<number>`count(*) filter (where type = 'span.model_request_end')`,
		})
		.from(sessionEvents)
		.where(eq(sessionEvents.sessionId, params.id));

	return json({
		sessionId: params.id,
		usage: session.usage,
		events: {
			total: Number(eventCount ?? 0),
			totalBytes: Number(totalBytes ?? 0),
			llmTurns: Number(turns ?? 0),
		},
	});
};
