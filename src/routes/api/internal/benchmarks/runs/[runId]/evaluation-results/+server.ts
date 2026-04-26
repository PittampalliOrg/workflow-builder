import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { and, eq, inArray } from "drizzle-orm";
import { requireInternal } from "$lib/server/internal-auth";
import { db } from "$lib/server/db";
import {
	benchmarkRunInstances,
	benchmarkRuns,
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
	if (body.error) {
		await markBenchmarkRunStatus(params.runId, "failed", { error: body.error });
		return json({ success: true });
	}
	const results = Array.isArray(body.results) ? body.results : [];
	for (const result of results) {
		const instanceId = result.instance_id ?? result.instanceId;
		if (!instanceId) continue;
		const status = mapHarnessStatus(result);
		await db
			.update(benchmarkRunInstances)
			.set({
				status,
				error: result.error ?? null,
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
			error: failed > 0 ? `${failed} benchmark instances did not resolve` : null,
		});
	}
	const [run] = await db
		.select()
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, params.runId))
		.limit(1);
	return json({ success: true, run, summary });
};

function mapHarnessStatus(result: EvaluationResult): BenchmarkRunInstanceStatus {
	if (result.status === "timeout") return "timeout";
	if (result.status === "error") return "error";
	if (result.resolved === true || result.status === "resolved") return "resolved";
	if (result.resolved === false || result.status === "failed") return "failed";
	return "error";
}
