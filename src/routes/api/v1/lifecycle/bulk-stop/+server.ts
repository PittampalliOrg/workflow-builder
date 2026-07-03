import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * POST /api/v1/lifecycle/bulk-stop
 *
 * Stop many durable runs in one request. The application service routes each
 * target through the same single-target lifecycle/cancel authorities and
 * returns mixed per-item outcomes for the Fleet view.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const result = await getApplicationAdapters().bulkLifecycleStop.stopMany({
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
		body: await request.json().catch(() => ({})),
	});

	if (result.status === "error") return error(result.httpStatus, result.message);
	return json(result.body);
};
