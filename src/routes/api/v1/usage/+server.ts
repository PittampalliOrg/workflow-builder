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
 * Usage analytics for a time range. Mirrors CMA's Usage page data shape:
 * total tokens in/out, per-day stacked bars, per-agent breakdown.
 *
 * Query params: ?start=ISO&end=ISO&groupBy=agent|day (default: day)
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters()
		.workflowData.getUsageAnalytics({
			userId: locals.session.userId,
			projectId: locals.session.projectId,
			start: url.searchParams.get("start"),
			end: url.searchParams.get("end"),
			groupBy: url.searchParams.get("groupBy"),
		})
		.catch(mapAdapterError);
	return json(result);
};
