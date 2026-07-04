import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Benchmark run not found");
	const run =
		await getApplicationAdapters().benchmarkRouteOperations.retryTerminalCleanup(
			locals.session.projectId,
			params.runId,
		);
	if (!run) return error(404, "Benchmark run not found");
	return json({ run });
};
