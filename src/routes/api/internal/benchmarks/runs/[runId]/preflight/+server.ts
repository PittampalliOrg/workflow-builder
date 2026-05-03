import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { applyBenchmarkRunPreflight } from "$lib/server/benchmarks/service";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (!body) return error(400, "JSON body required");
	const rawInstances = body.inferenceEnvironmentsByInstanceId;
	if (!rawInstances || typeof rawInstances !== "object" || Array.isArray(rawInstances)) {
		return error(400, "inferenceEnvironmentsByInstanceId is required");
	}
	const result = await applyBenchmarkRunPreflight({
		runId: params.runId,
		inferenceEnvironmentsByInstanceId: rawInstances as Record<string, unknown>,
		preflightSummary:
			body.preflightSummary && typeof body.preflightSummary === "object"
				? (body.preflightSummary as Record<string, unknown>)
				: null,
		capacitySnapshot:
			body.capacitySnapshot && typeof body.capacitySnapshot === "object"
				? (body.capacitySnapshot as Record<string, unknown>)
				: null,
	});
	if (!result) return error(404, "Benchmark run not found");
	return json({ success: true, ...result });
};
