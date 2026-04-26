import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getEvaluationRun } from "$lib/server/evaluations/service";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation run not found");
	const run = await getEvaluationRun(locals.session.projectId, params.runId);
	if (!run) return error(404, "Evaluation run not found");
	return json({ run });
};
