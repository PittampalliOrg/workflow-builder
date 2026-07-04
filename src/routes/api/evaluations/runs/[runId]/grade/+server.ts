import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEvaluationRunError } from "$lib/server/application/evaluation-runs";

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation run not found");
	try {
		return json(
			await getApplicationAdapters().evaluationRuns.gradeRun({
				projectId: locals.session.projectId,
				runId: params.runId,
			}),
		);
	} catch (err) {
		if (err instanceof ApplicationEvaluationRunError) {
			throw error(err.status, err.message);
		}
		throw err;
	}
};
