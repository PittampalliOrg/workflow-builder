import { error, text } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Benchmark run not found");
	const jsonl =
		await getApplicationAdapters().benchmarkRouteOperations.buildPredictionsJsonl(
			locals.session.projectId,
			params.runId,
		);
	if (jsonl === null) return error(404, "Benchmark run not found");
	return text(jsonl, {
		headers: {
			"Content-Type": "application/jsonl; charset=utf-8",
			"Content-Disposition": `attachment; filename="${params.runId}-predictions.jsonl"`,
		},
	});
};
