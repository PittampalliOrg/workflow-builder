import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	return json(
		await getApplicationAdapters().evaluationRunItems.startWorkflow({
			runId: params.runId,
			itemId: params.itemId,
		}),
	);
};
