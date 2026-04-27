import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { evaluationRuns, type EvaluationRunStatus } from "$lib/server/db/schema";
import { requireInternal } from "$lib/server/internal-auth";
import {
	getEvaluationRun,
	markEvaluationRunStatus,
	recomputeEvaluationRunSummary,
} from "$lib/server/evaluations/service";

const STATUSES = new Set([
	"queued",
	"running",
	"grading",
	"completed",
	"failed",
	"cancelled",
]);

export const GET: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	if (!db) return error(503, "Database not configured");
	const [run] = await db
		.select({ projectId: evaluationRuns.projectId })
		.from(evaluationRuns)
		.where(eq(evaluationRuns.id, params.runId))
		.limit(1);
	if (!run) return error(404, "Evaluation run not found");
	const fullRun = await getEvaluationRun(run.projectId, params.runId, {
		itemMode: "summary",
	});
	return json({ run: fullRun });
};

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const body = asRecord(await request.json().catch(() => ({})));
	const status = String(body.status ?? "");
	if (!STATUSES.has(status)) return error(400, "Invalid evaluation run status");
	const extra: Record<string, unknown> = {};
	if (typeof body.error === "string" || body.error === null) extra.error = body.error;
	if (typeof body.coordinatorExecutionId === "string") {
		extra.coordinatorExecutionId = body.coordinatorExecutionId;
	}
	if (isRecord(body.summary)) extra.summary = body.summary;
	if (isRecord(body.usage)) extra.usage = body.usage;
	const run = await markEvaluationRunStatus(
		params.runId,
		status as EvaluationRunStatus,
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
