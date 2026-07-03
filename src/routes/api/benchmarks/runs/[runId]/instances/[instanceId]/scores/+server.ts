import { error, json } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import type { RequestHandler } from "./$types";

// Phase G/I: scorer rows for a single benchmark instance.
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Run not found");

	const runId = params.runId;
	const instanceId = decodeURIComponent(params.instanceId ?? "");
	if (!runId || !instanceId) return error(400, "runId and instanceId required");

	let result;
	try {
		result = await getApplicationAdapters().workflowData.listBenchmarkRunInstanceScores({
			runId,
			instanceId,
			projectId: locals.session.projectId,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/Database not configured/.test(message)) {
			return error(503, "Database not configured");
		}
		throw err;
	}
	if (result.status === "run_not_found") return error(404, "Run not found");
	if (result.status === "instance_not_found") {
		return error(404, "Instance not found in this run");
	}

	return json({
		scores: result.scores.map((s) => ({
			...s,
			createdAt: s.createdAt.toISOString(),
		})),
	});
};
