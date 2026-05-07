import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { retryBenchmarkRunTerminalCleanupByRunId } from "$lib/server/benchmarks/service";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const run = await retryBenchmarkRunTerminalCleanupByRunId(params.runId);
	if (!run) return error(404, "Benchmark run not found");
	return json({ run });
};
