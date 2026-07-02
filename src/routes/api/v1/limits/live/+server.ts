import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

function mapAdapterError(err: unknown): never {
	if (err instanceof Error && err.message === "Database not configured") {
		throw error(503, "Database not configured");
	}
	throw err;
}

/**
 * GET /api/v1/limits/live
 *
 * Live consumption snapshot for the active workspace. We don't enforce
 * rate limits locally — that's the provider's job — but we can surface
 * the same numbers the limits page already shows as static text, which
 * gives operators a "how close am I to the ceiling right now" view.
 *
 * Shape:
 *   {
 *     activeSessions: number,
 *     byModel: [{ model, sessionsLastHour, tokensInLastHour,
 *                 tokensOutLastHour, tokensInLastMinute,
 *                 tokensOutLastMinute }]
 *   }
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters()
		.workflowData.getLiveLimitSnapshot({
			userId: locals.session.userId,
			projectId: locals.session.projectId,
		})
		.catch(mapAdapterError);
	return json(result);
};
