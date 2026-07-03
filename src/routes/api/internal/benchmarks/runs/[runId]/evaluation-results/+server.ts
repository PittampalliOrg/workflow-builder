import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";
import type { BenchmarkEvaluationResultInput } from "$lib/server/application/ports";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => ({}))) as {
		results?: BenchmarkEvaluationResultInput[];
		error?: string;
		jobName?: string;
	};
	const result = await getApplicationAdapters().workflowData.ingestBenchmarkEvaluationResults({
		runId: params.runId,
		results: Array.isArray(body.results) ? body.results : [],
		error: typeof body.error === "string" ? body.error : null,
		jobName: typeof body.jobName === "string" ? body.jobName : null,
	});

	if (result.status === "run_not_found") {
		return error(404, "Benchmark run not found");
	}
	if (result.status === "skipped") {
		return json({ success: true, skipped: true, run: result.run });
	}
	return json({
		success: true,
		run: result.run,
		summary: result.summary,
	});
};
