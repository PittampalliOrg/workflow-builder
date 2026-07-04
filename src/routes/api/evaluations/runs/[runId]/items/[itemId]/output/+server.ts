import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEvaluationRunItemError } from "$lib/server/application/evaluation-run-items";

export const POST: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation run not found");
	try {
		return json(
			await getApplicationAdapters().evaluationRunItems.updatePublicOutput({
				projectId: locals.session.projectId,
				runId: params.runId,
				itemId: params.itemId,
				body: await request.json().catch(() => ({})),
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
