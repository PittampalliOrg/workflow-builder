import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const background = body.background === true;
	const operations = getApplicationAdapters().benchmarkRouteOperations;
	const run = background
		? await operations.scheduleTerminalCleanupByRunId(params.runId)
		: await operations.retryTerminalCleanupByRunId(params.runId);
	if (!run) return error(404, "Benchmark run not found");
	return json({ run, background });
};
