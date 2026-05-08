import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { and, eq, inArray } from "drizzle-orm";
import { requireInternal } from "$lib/server/internal-auth";
import { db } from "$lib/server/db";
import {
	benchmarkInstances,
	benchmarkRunInstances,
	benchmarkRuns,
	type BenchmarkEvaluationStatus,
	type BenchmarkRunInstanceStatus,
} from "$lib/server/db/schema";
import {
	getSwebenchCoordinatorUrl,
	markBenchmarkRunStatus,
	recomputeRunSummary,
} from "$lib/server/benchmarks/service";
import { syncBenchmarkInstanceMlflow } from "$lib/server/benchmarks/mlflow";
import { compareToGold, parsePatchStats } from "$lib/server/benchmarks/patch-compare";
import { daprFetch } from "$lib/server/dapr-client";
import { env } from "$env/dynamic/private";

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

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	if (!db) return error(503, "Database not configured");
	const body = (await request.json().catch(() => ({}))) as {
		results?: EvaluationResult[];
		error?: string;
		jobName?: string;
	};
	const evaluatorError =
		typeof body.error === "string" && body.error.trim() ? body.error.trim() : null;
	const results = Array.isArray(body.results) ? body.results : [];
	const [currentRun] = await db
		.select()
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, params.runId))
		.limit(1);
	if (!currentRun) return error(404, "Benchmark run not found");
	if (TERMINAL_RUN_STATUSES.has(currentRun.status)) {
		await notifyCoordinatorEvaluationEvent(params.runId, {
			eventType: results.length > 0 ? "results" : "failed",
			jobName: body.jobName,
			error: evaluatorError ?? `ignored callback for terminal ${currentRun.status} run`,
		});
		return json({ success: true, skipped: true, run: currentRun });
	}
	if (currentRun.status === "inferencing") {
		const marked = await markBenchmarkRunStatus(params.runId, "evaluating", {
			...(typeof body.jobName === "string" ? { evaluatorJobName: body.jobName } : {}),
		});
		if (marked && TERMINAL_RUN_STATUSES.has(marked.status)) {
			await notifyCoordinatorEvaluationEvent(params.runId, {
				eventType: results.length > 0 ? "results" : "failed",
				jobName: body.jobName,
				error: evaluatorError ?? `ignored callback for terminal ${marked.status} run`,
			});
			return json({ success: true, skipped: true, run: marked });
		}
	}
	if (evaluatorError && results.length === 0) {
		await markBenchmarkRunStatus(params.runId, "failed", { error: evaluatorError });
		await notifyCoordinatorEvaluationEvent(params.runId, {
			eventType: "failed",
			jobName: body.jobName,
			error: evaluatorError,
		});
		return json({ success: true });
	}
	const patchContext = await loadPatchContextForRun(params.runId);
	const mlflowInstanceIds: string[] = [];
	for (const result of results) {
		const instanceId = result.instance_id ?? result.instanceId;
		if (!instanceId) continue;
		mlflowInstanceIds.push(instanceId);
		const { status, evaluationStatus } = mapHarnessStatus(result);
		const evaluationError = result.error ?? null;
		const ctx = patchContext.get(instanceId);
		const stats = ctx ? parsePatchStats(ctx.modelPatch) : null;
		const overlap = ctx ? compareToGold(ctx.modelPatch, ctx.goldPatch) : null;
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
				patchAddedLines: stats?.addedLines ?? null,
				patchRemovedLines: stats?.removedLines ?? null,
				patchFilesTouched: stats?.filesTouched.length ?? null,
				patchFilesOverlapGold: overlap?.filesOverlap ?? null,
				patchWellFormed: stats?.wellFormed ?? null,
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
	syncEvaluationResultMlflowInBackground(params.runId, mlflowInstanceIds);
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
		const failed =
			Number(summary.failed ?? 0) +
			Number(summary.error ?? 0) +
			Number(summary.timeout ?? 0);
		await markBenchmarkRunStatus(params.runId, "completed", {
			summary,
			error:
				failed > 0
					? `${failed} benchmark instances did not resolve`
					: evaluatorError,
		});
	}
	const [run] = await db
		.select()
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, params.runId))
		.limit(1);
	await notifyCoordinatorEvaluationEvent(params.runId, {
		eventType: results.length > 0 ? "results" : "failed",
		jobName: body.jobName,
		error: evaluatorError,
	});
	return json({ success: true, run, summary });
};

async function loadPatchContextForRun(runId: string) {
	if (!db) return new Map<string, { modelPatch: string | null; goldPatch: string | null }>();
	const rows = await db
		.select({
			instanceId: benchmarkRunInstances.instanceId,
			modelPatch: benchmarkRunInstances.modelPatch,
			goldPatch: benchmarkInstances.goldPatch,
		})
		.from(benchmarkRunInstances)
		.leftJoin(
			benchmarkInstances,
			eq(benchmarkInstances.id, benchmarkRunInstances.benchmarkInstanceId),
		)
		.where(eq(benchmarkRunInstances.runId, runId));
	const map = new Map<string, { modelPatch: string | null; goldPatch: string | null }>();
	for (const row of rows) {
		map.set(row.instanceId, { modelPatch: row.modelPatch, goldPatch: row.goldPatch });
	}
	return map;
}

async function notifyCoordinatorEvaluationEvent(
	runId: string,
	event: { eventType: "results" | "failed"; jobName?: string; error?: string | null },
) {
	if (!env.INTERNAL_API_TOKEN) return;
	try {
		const res = await daprFetch(
			`${getSwebenchCoordinatorUrl()}/api/v1/benchmark-runs/${runId}/evaluation-events`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Internal-Token": env.INTERNAL_API_TOKEN,
				},
				body: JSON.stringify({
					eventType: event.eventType,
					jobName: event.jobName,
					error: event.error,
					postedAt: new Date().toISOString(),
				}),
				maxRetries: 0,
			},
		);
		if (!res.ok) {
			console.warn(
				`SWE-bench coordinator evaluation event notification failed for ${runId}: ${res.status} ${await res.text()}`,
			);
		}
	} catch (err) {
		console.warn(
			`SWE-bench coordinator evaluation event notification failed for ${runId}:`,
			err,
		);
	}
}

function syncEvaluationResultMlflowInBackground(
	runId: string,
	instanceIds: string[],
) {
	const uniqueInstanceIds = [...new Set(instanceIds)];
	if (uniqueInstanceIds.length === 0) return;
	void (async () => {
		for (const instanceId of uniqueInstanceIds) {
			try {
				await syncBenchmarkInstanceMlflow({ runId, instanceId });
			} catch (err) {
				console.warn(
					`SWE-bench MLflow evaluation sync failed for ${runId}/${instanceId}:`,
					err,
				);
			}
		}
	})();
}

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
