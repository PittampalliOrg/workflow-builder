import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * Dashboard summary: active sessions count, sessions today, 7-day token
 * usage, active-sessions list, recent-version-bump feed, resource counts.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		return json(
			await getApplicationAdapters().workflowData.getDashboard({
				userId: locals.session.userId,
			}),
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/Database not configured/.test(message)) {
			return error(503, "Database not configured");
		}
		throw err;
	}
};
