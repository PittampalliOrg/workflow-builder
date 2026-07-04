import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEvaluationRunItemError } from "$lib/server/application/evaluation-run-items";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	try {
		return json(
			await getApplicationAdapters().evaluationRunItems.updateInternalOutput({
				runId: params.runId,
				itemId: params.itemId,
				body: await request.json().catch(() => ({})),
			}),
		);
	} catch (err) {
		if (err instanceof ApplicationEvaluationRunItemError) {
			throw error(err.status, err.message);
		}
		throw err;
	}
};
