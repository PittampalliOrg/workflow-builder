import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEvaluationRunItemError } from "$lib/server/application/evaluation-run-items";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation run item not found");
	try {
		return json(
			await getApplicationAdapters().evaluationRunItems.get({
				projectId: locals.session.projectId,
				runId: params.runId,
				itemId: params.itemId,
			}),
		);
	} catch (err) {
		handleEvaluationRunItemError(err);
	}
};

function handleEvaluationRunItemError(err: unknown): never {
	if (err instanceof ApplicationEvaluationRunItemError) {
		throw error(err.status, err.message);
	}
	throw err;
}
