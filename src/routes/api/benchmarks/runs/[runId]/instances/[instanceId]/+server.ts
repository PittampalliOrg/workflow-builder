import { error, json } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");

	const runId = params.runId;
	const instanceId = decodeURIComponent(params.instanceId ?? "");

	let result;
	try {
		result = await getApplicationAdapters().benchmarkRunInstanceDetail.getDetail({
			runId,
			instanceId,
			projectId: locals.session.projectId ?? null,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/Database not configured/.test(message)) {
			return error(503, "Database not configured");
		}
		throw err;
	}

	if (result.status === "bad_request") return error(400, result.message);
	if (result.status === "run_not_found") return error(404, result.message);
	if (result.status === "instance_not_found") return error(404, result.message);
	return json(result.body);
};
