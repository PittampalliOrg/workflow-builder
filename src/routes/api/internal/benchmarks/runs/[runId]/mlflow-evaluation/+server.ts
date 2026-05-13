import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { recordBenchmarkMlflowEvaluation } from "$lib/server/benchmarks/service";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const mlflowEvalRunId =
		typeof body.mlflowEvalRunId === "string" ? body.mlflowEvalRunId.trim() : "";
	if (!mlflowEvalRunId) return error(400, "mlflowEvalRunId is required");
	const summary =
		body.summary && typeof body.summary === "object" && !Array.isArray(body.summary)
			? (body.summary as Record<string, unknown>)
			: null;
	const result = await recordBenchmarkMlflowEvaluation({
		runId: params.runId,
		mlflowEvalRunId,
		summary,
	});
	if (!result) return error(404, "Benchmark run not found");
	return json({ success: true, ...result });
};
