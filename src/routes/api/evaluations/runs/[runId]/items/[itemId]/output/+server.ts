import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	getEvaluationRun,
	updateEvaluationRunItemOutput,
} from "$lib/server/evaluations/service";

export const POST: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation run not found");
	const run = await getEvaluationRun(locals.session.projectId, params.runId);
	if (!run) return error(404, "Evaluation run not found");
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
	const updatedRun = await getEvaluationRun(locals.session.projectId, params.runId);
	return json({ item, run: updatedRun });
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
