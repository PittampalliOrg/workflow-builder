import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters().runCancellation.cancelBenchmarkRun({
		projectId: locals.session.projectId,
		runId: params.runId,
	});
	if (result.status === "not_found") return error(404, result.message);
	return json(result.body);
};
