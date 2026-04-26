import { error, text } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { buildEvaluationPredictionsJsonl } from "$lib/server/evaluations/service";

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation run not found");
	const jsonl = await buildEvaluationPredictionsJsonl(
		locals.session.projectId,
		params.runId,
	);
	return text(jsonl, {
		headers: {
			"Content-Type": "application/jsonl; charset=utf-8",
			"Content-Disposition": `attachment; filename="${params.runId}-predictions.jsonl"`,
		},
	});
};
