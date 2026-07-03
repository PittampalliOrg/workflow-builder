import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import {
	recordEvaluationRunItemGraderResults,
	type EvaluationRunItemStatusInput,
} from "$lib/server/evaluations/service";

const STATUSES = new Set([
	"queued",
	"running",
	"grading",
	"passed",
	"failed",
	"error",
	"cancelled",
	"skipped",
]);

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const body = asRecord(await request.json().catch(() => ({})));
	const graderResults = asRecord(body.graderResults ?? body.results);
	if (Object.keys(graderResults).length === 0) {
		return error(400, "graderResults is required");
	}
	const rawStatus = typeof body.status === "string" ? body.status : null;
	const item = await recordEvaluationRunItemGraderResults({
		runId: params.runId,
		itemId: params.itemId,
		graderResults,
		scores: asOptionalRecord(body.scores),
		status:
			rawStatus && STATUSES.has(rawStatus)
				? (rawStatus as EvaluationRunItemStatusInput)
				: undefined,
		error:
			typeof body.error === "string" || body.error === null
				? body.error
				: undefined,
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
