import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { startBenchmarkInstanceWorkflow } from "$lib/server/benchmarks/service";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const result = await startBenchmarkInstanceWorkflow({
		runId: params.runId,
		instanceId: params.instanceId,
	});
	return json({ success: true, ...result });
};
