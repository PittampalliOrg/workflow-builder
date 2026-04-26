import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { updateEvaluationRunItemOutput } from "$lib/server/evaluations/service";

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const body = asRecord(await request.json().catch(() => ({})));
	const item = await updateEvaluationRunItemOutput({
		runId: params.runId,
		itemId: params.itemId,
		generatedOutput: body.generatedOutput ?? body.output,
		usage: asOptionalRecord(body.usage),
		traceIds: Array.isArray(body.traceIds)
			? body.traceIds.map((traceId) => String(traceId))
			: undefined,
		autoGrade: body.autoGrade !== false,
	});
	if (!item) return error(404, "Evaluation run item not found");
	return json({ success: true, item });
};

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
