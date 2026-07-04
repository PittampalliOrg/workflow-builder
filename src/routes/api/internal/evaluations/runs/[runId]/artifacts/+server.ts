import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";
import { ApplicationEvaluationRunError } from "$lib/server/application/evaluation-runs";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	try {
		return json(
			await getApplicationAdapters().evaluationRuns.recordArtifact({
				runId: params.runId,
				body: await request.json().catch(() => ({})),
			}),
		);
	} catch (err) {
		if (err instanceof ApplicationEvaluationRunError) {
			throw error(err.status, err.message);
		}
		throw err;
	}
};
