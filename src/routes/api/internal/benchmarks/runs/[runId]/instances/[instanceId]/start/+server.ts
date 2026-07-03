import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const result =
		await getApplicationAdapters().benchmarkInstanceLifecycle.startBenchmarkInstanceWorkflow({
			runId: params.runId,
			instanceId: params.instanceId,
		});
	return json({ success: true, ...result });
};
