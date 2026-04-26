import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { syncBenchmarkInstanceFromExecution } from "$lib/server/benchmarks/service";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const instance = await syncBenchmarkInstanceFromExecution({
		runId: params.runId,
		instanceId: params.instanceId,
	});
	if (!instance) return error(404, "Benchmark instance not found");
	return json({ success: true, instance });
};
