import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { syncEvaluationRunItemFromExecution } from "$lib/server/evaluations/service";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const item = await syncEvaluationRunItemFromExecution({
		runId: params.runId,
		itemId: params.itemId,
	});
	if (!item) return error(404, "Evaluation run item not found");
	return json({ success: true, item });
};
