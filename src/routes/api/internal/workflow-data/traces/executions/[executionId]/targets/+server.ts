import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternal } from "$lib/server/internal-auth";

export const GET: RequestHandler = async ({ params, request }) => {
	requireInternal(request);
	const executionId = params.executionId?.trim();
	if (!executionId) return error(400, "executionId required");

	const targets =
		await getApplicationAdapters().workflowData.getTraceTargetsForExecution(
			executionId,
		);
	return json({ targets });
};
