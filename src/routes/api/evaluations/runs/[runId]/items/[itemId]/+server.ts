import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getEvaluationRunItem } from "$lib/server/evaluations/service";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation run item not found");
	const item = await getEvaluationRunItem(
		locals.session.projectId,
		params.runId,
		params.itemId,
	);
	if (!item) return error(404, "Evaluation run item not found");
	return json({ item });
};
