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
 * Cost aggregation for a time range. The `api_key` query param is accepted
 * but currently a no-op: sessions are not yet tagged with api_key_id.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters()
		.workflowData.getCostBreakdown({
			userId: locals.session.userId,
			projectId: locals.session.projectId,
			start: url.searchParams.get("start"),
			end: url.searchParams.get("end"),
		})
		.catch(mapAdapterError);
	return json(result);
};
