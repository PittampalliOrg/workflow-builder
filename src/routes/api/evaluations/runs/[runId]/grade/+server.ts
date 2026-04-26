import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { gradeEvaluationRun } from "$lib/server/evaluations/service";

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation run not found");
	const run = await gradeEvaluationRun(locals.session.projectId, params.runId);
	return json({ run });
};
