import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import {
	getBenchmarkRun,
	markBenchmarkRunStatus,
	recomputeRunSummary,
} from "$lib/server/benchmarks/service";
import { getApplicationAdapters } from "$lib/server/application";

export const GET: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	let projectId;
	try {
		projectId = await getApplicationAdapters().workflowData.getBenchmarkRunProjectId(
			params.runId,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/Database not configured/.test(message)) {
			return error(503, "Database not configured");
		}
		throw err;
	}
	if (!projectId) return error(404, "Benchmark run not found");
	const fullRun = await getBenchmarkRun(projectId, params.runId);
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
	const run = await markBenchmarkRunStatus(params.runId, status, extra, {
		terminalCleanup:
			status === "failed" || status === "cancelled" ? "background" : "sync",
	});
	if (!run) return error(404, "Benchmark run not found");
	try {
		await recomputeRunSummary(params.runId);
	} catch (err) {
		console.warn(
			`Benchmark run ${params.runId} status ${status} committed, but summary recompute failed:`,
			err instanceof Error ? err.message : err,
		);
	}
	return json({ success: true, run });
};
