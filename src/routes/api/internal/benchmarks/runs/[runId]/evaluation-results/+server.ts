import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { and, eq, inArray } from "drizzle-orm";
import { requireInternal } from "$lib/server/internal-auth";
import { db } from "$lib/server/db";
import {
	benchmarkRunInstances,
	benchmarkRuns,
	type BenchmarkEvaluationStatus,
	type BenchmarkRunInstanceStatus,
} from "$lib/server/db/schema";
import {
	markBenchmarkRunStatus,
	recomputeRunSummary,
} from "$lib/server/benchmarks/service";

type EvaluationResult = {
	instance_id?: string;
	instanceId?: string;
	resolved?: boolean;
	status?: string;
	error?: string;
	logs_path?: string;
	logsPath?: string;
	test_output_summary?: string;
	testOutputSummary?: string;
	harness_result?: Record<string, unknown>;
	harnessResult?: Record<string, unknown>;
};

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	if (!db) return error(503, "Database not configured");
	const body = (await request.json().catch(() => ({}))) as {
		results?: EvaluationResult[];
		error?: string;
	};
	const evaluatorError =
		typeof body.error === "string" && body.error.trim() ? body.error.trim() : null;
	const results = Array.isArray(body.results) ? body.results : [];
	if (evaluatorError && results.length === 0) {
		await markBenchmarkRunStatus(params.runId, "failed", { error: evaluatorError });
		return json({ success: true });
	}
	for (const result of results) {
		const instanceId = result.instance_id ?? result.instanceId;
		if (!instanceId) continue;
		const { status, evaluationStatus } = mapHarnessStatus(result);
		const evaluationError = result.error ?? null;
		await db
			.update(benchmarkRunInstances)
			.set({
				status,
				evaluationStatus,
				error: evaluationError,
				evaluationError,
				logsPath: result.logs_path ?? result.logsPath ?? null,
				testOutputSummary:
					result.test_output_summary ?? result.testOutputSummary ?? null,
				harnessResult: result.harness_result ?? result.harnessResult ?? null,
				evaluatedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(benchmarkRunInstances.runId, params.runId),
					eq(benchmarkRunInstances.instanceId, instanceId),
				),
			);
	}
	const summary = await recomputeRunSummary(params.runId);
	const activeRows = await db
		.select({ id: benchmarkRunInstances.id })
		.from(benchmarkRunInstances)
		.where(
			and(
				eq(benchmarkRunInstances.runId, params.runId),
				inArray(benchmarkRunInstances.status, [
					"queued",
					"inferencing",
					"inferred",
					"evaluating",
				] satisfies BenchmarkRunInstanceStatus[]),
			),
		);
	if (activeRows.length === 0) {
		const failed = (summary.failed ?? 0) + (summary.error ?? 0) + (summary.timeout ?? 0);
		await markBenchmarkRunStatus(params.runId, "completed", {
			summary,
			error:
				failed > 0
					? `${failed} benchmark instances did not resolve`
					: evaluatorError,
		});
	} else if (evaluatorError) {
		await markBenchmarkRunStatus(params.runId, "failed", { error: evaluatorError });
	}
	const [run] = await db
		.select()
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, params.runId))
		.limit(1);
	return json({ success: true, run, summary });
};

function mapHarnessStatus(result: EvaluationResult): {
	status: BenchmarkRunInstanceStatus;
	evaluationStatus: BenchmarkEvaluationStatus;
} {
	if (result.status === "timeout") {
		return { status: "timeout", evaluationStatus: "timeout" };
	}
	if (result.status === "error") {
		return { status: "error", evaluationStatus: "error" };
	}
	if (result.status === "empty_patch") {
		return { status: "failed", evaluationStatus: "empty_patch" };
	}
	if (result.resolved === true || result.status === "resolved") {
		return { status: "resolved", evaluationStatus: "resolved" };
	}
	if (
		result.resolved === false ||
		result.status === "failed" ||
		result.status === "unresolved"
	) {
		return { status: "failed", evaluationStatus: "unresolved" };
	}
	return { status: "error", evaluationStatus: "error" };
}
