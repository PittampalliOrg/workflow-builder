import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
	markEvaluationRunItemStatus,
	type EvaluationRunItemStatusInput,
} from "$lib/server/evaluations/service";
import { requireInternal } from "$lib/server/internal-auth";

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
	const status = String(body.status ?? "");
	if (!STATUSES.has(status)) return error(400, "Invalid evaluation run item status");
	const item = await markEvaluationRunItemStatus({
		runId: params.runId,
		itemId: params.itemId,
		status: status as EvaluationRunItemStatusInput,
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
