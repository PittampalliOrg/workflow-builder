import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEvaluationRunError } from "$lib/server/application/evaluation-runs";

export const GET: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	try {
		return json(
			await getApplicationAdapters().evaluationRuns.getInternalStatus({
				runId: params.runId,
			}),
		);
	} catch (err) {
		handleEvaluationRunError(err);
	}
};

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	try {
		return json(
			await getApplicationAdapters().evaluationRuns.markStatus({
				runId: params.runId,
				body: await request.json().catch(() => ({})),
			}),
		);
	} catch (err) {
		handleEvaluationRunError(err);
	}
};

function handleEvaluationRunError(err: unknown): never {
	if (err instanceof ApplicationEvaluationRunError) {
		throw error(err.status, err.message);
	}
	throw err;
}
