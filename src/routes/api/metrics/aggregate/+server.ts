import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { getAggregateMetrics } from "$lib/server/metrics/aggregate";

/**
 * Aggregate workflow metrics for the admin dashboard.
 *
 * Polled every 5 s by /admin/metrics. Admin-gated because it surfaces
 * cross-workspace counts; the (admin)/+layout.server.ts gate handles
 * the same role check for the page, but we double-check here so the
 * route can't be hit directly by a MEMBER user. platformRole lives on
 * the users row, not on locals.session — see +layout.server.ts.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	try {
		const isAdmin = await getApplicationAdapters().workflowData.isPlatformAdmin(
			locals.session.userId,
		);
		if (!isAdmin) return error(403, "Admin access required");
	} catch (err) {
		if (err instanceof Error && err.message.includes("Database not configured")) {
			return error(503, "Database not configured");
		}
		throw err;
	}
	const snapshot = await getAggregateMetrics();
	return json(snapshot);
};
