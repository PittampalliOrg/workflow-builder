import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";

export const GET: RequestHandler = async ({ request, params }) => {
	requireInternal(request);

	let result;
	try {
		result = await getApplicationAdapters().workflowData.getBenchmarkRunInstanceProgress({
			runId: params.runId,
			instanceId: params.instanceId,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/Database not configured/.test(message)) {
			return error(503, "Database not configured");
		}
		throw err;
	}
	if (result.status === "not_found") return error(404, "Benchmark instance not found");

	return json({
		status: result.runInstanceStatus,
		inferenceStatus: result.inferenceStatus,
		evaluationStatus: result.evaluationStatus,
		sessionId: result.sessionId,
		latestSessionEventType: result.latestSessionEventType,
		latestSessionEventSequence: result.latestSessionEventSequence,
		latestActivityAt: result.latestActivityAt.toISOString(),
		activityAgeSeconds: result.activityAgeSeconds,
		progressMarker: result.progressMarker,
	});
};
