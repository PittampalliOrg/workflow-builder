import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import {
	getInternalEvaluationRun,
	markEvaluationRunStatus,
	recomputeEvaluationRunSummary,
} from "$lib/server/evaluations/service";

type EvaluationRunStatusInput = Parameters<typeof markEvaluationRunStatus>[1];

const STATUSES = new Set<EvaluationRunStatusInput>([
	"queued",
	"running",
	"grading",
	"completed",
	"failed",
	"cancelled",
]);

export const GET: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const fullRun = await getInternalEvaluationRun(params.runId, {
		itemMode: "summary",
	});
	if (!fullRun) return error(404, "Evaluation run not found");
	return json({ run: fullRun });
};

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const body = asRecord(await request.json().catch(() => ({})));
	const status = String(body.status ?? "");
	if (!isEvaluationRunStatus(status)) return error(400, "Invalid evaluation run status");
	const extra: Record<string, unknown> = {};
	if (typeof body.error === "string" || body.error === null) extra.error = body.error;
	if (typeof body.coordinatorExecutionId === "string") {
		extra.coordinatorExecutionId = body.coordinatorExecutionId;
	}
	if (isRecord(body.summary)) extra.summary = body.summary;
	if (isRecord(body.usage)) extra.usage = body.usage;
	const run = await markEvaluationRunStatus(
		params.runId,
		status,
		extra,
	);
	if (!run) return error(404, "Evaluation run not found");
	await recomputeEvaluationRunSummary(params.runId);
	return json({ success: true, run });
};

function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvaluationRunStatus(status: string): status is EvaluationRunStatusInput {
	return STATUSES.has(status as EvaluationRunStatusInput);
}
