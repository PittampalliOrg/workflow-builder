import { error, text } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEvaluationRunError } from "$lib/server/application/evaluation-runs";

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation run not found");
	try {
		const jsonl = await getApplicationAdapters().evaluationRuns.buildPredictionsJsonl({
			projectId: locals.session.projectId,
			runId: params.runId,
		});
		return text(jsonl, {
			headers: {
				"Content-Type": "application/jsonl; charset=utf-8",
				"Content-Disposition": `attachment; filename="${params.runId}-predictions.jsonl"`,
			},
		});
	} catch (err) {
		if (err instanceof ApplicationEvaluationRunError) {
			throw error(err.status, err.message);
		}
		throw err;
	}
};
