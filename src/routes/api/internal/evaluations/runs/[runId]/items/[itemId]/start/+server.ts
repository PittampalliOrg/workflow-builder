import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { startEvaluationRunItemWorkflow } from "$lib/server/evaluations/service";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const result = await startEvaluationRunItemWorkflow({
		runId: params.runId,
		itemId: params.itemId,
	});
	return json({ success: true, ...result });
};
