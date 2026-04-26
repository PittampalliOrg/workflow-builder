import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import {
	getBenchmarkRun,
	markBenchmarkRunStatus,
	recomputeRunSummary,
} from "$lib/server/benchmarks/service";
import { db } from "$lib/server/db";
import { benchmarkRuns } from "$lib/server/db/schema";
import { eq } from "drizzle-orm";

export const GET: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	if (!db) return error(503, "Database not configured");
	const [run] = await db
		.select({ projectId: benchmarkRuns.projectId })
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, params.runId))
		.limit(1);
	if (!run) return error(404, "Benchmark run not found");
	const fullRun = await getBenchmarkRun(run.projectId, params.runId);
	return json({ run: fullRun });
};

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const status = typeof body.status === "string" ? body.status : "";
	if (
		status !== "queued" &&
		status !== "inferencing" &&
		status !== "evaluating" &&
		status !== "completed" &&
		status !== "failed" &&
		status !== "cancelled"
	) {
		return error(400, "Invalid benchmark run status");
	}
	const extra: Record<string, unknown> = {};
	if (typeof body.error === "string") extra.error = body.error;
	if (typeof body.evaluatorJobName === "string") {
		extra.evaluatorJobName = body.evaluatorJobName;
	}
	if (typeof body.predictionsPath === "string") {
		extra.predictionsPath = body.predictionsPath;
	}
	const run = await markBenchmarkRunStatus(params.runId, status, extra);
	if (!run) return error(404, "Benchmark run not found");
	await recomputeRunSummary(params.runId);
	return json({ success: true, run });
};
