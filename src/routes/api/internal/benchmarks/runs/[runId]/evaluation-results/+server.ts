import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { and, eq, inArray, sql } from "drizzle-orm";
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
	// Build the per-row update payload once, JS-side. Filters out results
	// missing instance_id (same as the previous loop's `if (!instanceId) continue`).
	const updates = results
		.map((result) => {
			const instanceId = result.instance_id ?? result.instanceId;
			if (!instanceId) return null;
			const { status, evaluationStatus } = mapHarnessStatus(result);
			const ctx = patchContext.get(instanceId);
			const stats = ctx ? parsePatchStats(ctx.modelPatch) : null;
			const overlap = ctx ? compareToGold(ctx.modelPatch, ctx.goldPatch) : null;
			return {
				instance_id: instanceId,
				status,
				evaluation_status: evaluationStatus,
				error: result.error ?? null,
				evaluation_error: result.error ?? null,
				logs_path: result.logs_path ?? result.logsPath ?? null,
				test_output_summary:
					result.test_output_summary ?? result.testOutputSummary ?? null,
				harness_result: result.harness_result ?? result.harnessResult ?? null,
				patch_added_lines: stats?.addedLines ?? null,
				patch_removed_lines: stats?.removedLines ?? null,
				patch_files_touched: stats?.filesTouched.length ?? null,
				patch_files_overlap_gold: overlap?.filesOverlap ?? null,
				patch_well_formed: stats?.wellFormed ?? null,
			};
		})
		.filter((u): u is NonNullable<typeof u> => u !== null);
	const mlflowInstanceIds = updates.map((u) => u.instance_id);
	// One SQL statement updates all rows via jsonb_to_recordset. Replaces a
	// 177-iteration sequential UPDATE loop that was hitting the Tekton
	// finalize task's 120s read timeout (Phase-4 177-way run, 2026-05-09).
	// All rows share one `evaluated_at` timestamp — they ARE one batch.
	if (updates.length > 0) {
		const now = new Date();
		await db.execute(sql`
			UPDATE benchmark_run_instances AS b
			SET status = u.status,
			    evaluation_status = u.evaluation_status,
			    error = u.error,
			    evaluation_error = u.evaluation_error,
			    logs_path = u.logs_path,
			    test_output_summary = u.test_output_summary,
			    harness_result = u.harness_result,
			    patch_added_lines = u.patch_added_lines,
			    patch_removed_lines = u.patch_removed_lines,
			    patch_files_touched = u.patch_files_touched,
			    patch_files_overlap_gold = u.patch_files_overlap_gold,
			    patch_well_formed = u.patch_well_formed,
			    evaluated_at = ${now},
			    updated_at = ${now}
			FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
			     AS u(
			       instance_id text,
			       status text,
			       evaluation_status text,
			       error text,
			       evaluation_error text,
			       logs_path text,
			       test_output_summary text,
			       harness_result jsonb,
			       patch_added_lines integer,
			       patch_removed_lines integer,
			       patch_files_touched integer,
			       patch_files_overlap_gold integer,
			       patch_well_formed boolean
			     )
			WHERE b.run_id = ${params.runId} AND b.instance_id = u.instance_id
		`);
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
