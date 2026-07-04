import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { getApplicationAdapters } from "$lib/server/application";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const result = await getApplicationAdapters().benchmarkMlflowEvaluation.recordEvaluation({
		runId: params.runId,
		body,
	});
	if (result.status === "invalid") return error(400, result.message);
	if (result.status === "not_found") return error(404, result.message);
	return json({ success: true, ...result.record });
};
