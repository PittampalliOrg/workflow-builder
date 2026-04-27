import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getEvaluationRun } from "$lib/server/evaluations/service";

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation run not found");
	const itemMode = url.searchParams.get("items") === "summary" ? "summary" : "full";
	const run = await getEvaluationRun(locals.session.projectId, params.runId, {
		itemMode,
	});
	if (!run) return error(404, "Evaluation run not found");
	return json({ run });
};
