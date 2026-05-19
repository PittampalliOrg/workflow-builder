import { error, json } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { publicSwebenchTestMetadata } from "$lib/server/benchmarks/contamination";
import {
	benchmarkInstances,
	benchmarkRuns,
	benchmarkRunInstances,
	workflowExecutions,
} from "$lib/server/db/schema";
import { publicMlflowRunUrl, publicMlflowTracesUrl } from "$lib/server/benchmarks/mlflow";
import { parseHarnessResult } from "$lib/server/benchmarks/harness-result";
import { parsePatchStats } from "$lib/server/benchmarks/patch-compare";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Run not found");
	if (!db) return error(503, "Database not configured");
	const database = db;

	const runId = params.runId;
	const instanceId = decodeURIComponent(params.instanceId ?? "");
	if (!runId || !instanceId) return error(400, "runId and instanceId required");

	const [runRow] = await database
		.select({
			id: benchmarkRuns.id,
			suiteId: benchmarkRuns.suiteId,
			mlflowExperimentId: benchmarkRuns.mlflowExperimentId,
		})
		.from(benchmarkRuns)
		.where(
			and(
				eq(benchmarkRuns.id, runId),
				eq(benchmarkRuns.projectId, locals.session.projectId),
			),
		)
		.limit(1);
	if (!runRow) return error(404, "Run not found");

	const [row] = await database
		.select({
			run: benchmarkRunInstances,
			goldPatch: benchmarkInstances.goldPatch,
			problemStatement: benchmarkInstances.problemStatement,
			hintsText: benchmarkInstances.hintsText,
			testMetadata: benchmarkInstances.testMetadata,
			repo: benchmarkInstances.repo,
			baseCommit: benchmarkInstances.baseCommit,
			instanceMetadata: benchmarkInstances.metadata,
			executionIr: workflowExecutions.executionIr,
			executionOutput: workflowExecutions.output,
		})
		.from(benchmarkRunInstances)
		.leftJoin(
			benchmarkInstances,
			and(
				eq(benchmarkInstances.suiteId, runRow.suiteId),
				eq(benchmarkInstances.instanceId, benchmarkRunInstances.instanceId),
			),
		)
		.leftJoin(
			workflowExecutions,
			eq(workflowExecutions.id, benchmarkRunInstances.workflowExecutionId),
		)
		.where(
			and(
				eq(benchmarkRunInstances.runId, runId),
				eq(benchmarkRunInstances.instanceId, instanceId),
			),
		)
		.limit(1);

	if (!row) return error(404, "Instance not found in this run");

	const parsedHarness = parseHarnessResult(row.run.harnessResult);
	const postHocEvaluationArtifactsAvailable =
		row.run.evaluatedAt != null ||
		["resolved", "unresolved", "empty_patch", "error", "timeout", "cancelled"].includes(
			row.run.evaluationStatus,
		);
	const goldPatch = postHocEvaluationArtifactsAvailable ? row.goldPatch : null;
	const goldPatchStats = parsePatchStats(goldPatch);
	const hostJobName = extractBenchmarkHostJobName(
		row.executionIr,
		row.executionOutput,
	);

	return json({
		runInstance: {
			...row.run,
			hostJobName,
			mlflowUrl: publicMlflowRunUrl(runRow.mlflowExperimentId, row.run.mlflowRunId),
			mlflowTracesUrl: publicMlflowTracesUrl(
				runRow.mlflowExperimentId,
				(row.run.traceIds ?? [])[0],
			),
		},
		instance: {
			repo: row.repo,
			baseCommit: row.baseCommit,
			problemStatement: row.problemStatement,
			hintsText: row.hintsText,
			testMetadata: publicSwebenchTestMetadata(row.testMetadata),
			metadata: row.instanceMetadata,
		},
		goldPatch,
		goldPatchStats: {
			addedLines: goldPatchStats.addedLines,
			removedLines: goldPatchStats.removedLines,
			filesTouched: goldPatchStats.filesTouched.length,
		},
		parsedHarness,
		postHocEvaluationArtifactsAvailable,
	});
};

function extractBenchmarkHostJobName(
	executionIr: unknown,
	executionOutput: unknown,
): string | null {
	const candidates: unknown[] = [];
	for (const source of [executionIr, executionOutput]) {
		const root = asRecord(source);
		if (!root) continue;
		candidates.push(root.jobName, root.job_name, root.kubernetesJobName);
		for (const key of ["dispatch", "hostExecution", "job", "kubernetes"] as const) {
			const nested = asRecord(root[key]);
			if (!nested) continue;
			candidates.push(nested.jobName, nested.job_name, nested.kubernetesJobName);
		}
		candidates.push(...collectJobNames(root));
	}
	for (const candidate of candidates) {
		const value = asNonEmptyString(candidate);
		if (value) return value;
	}
	return null;
}

function collectJobNames(value: unknown, depth = 0, seen = new Set<object>()): unknown[] {
	if (depth > 6 || value == null || typeof value !== "object") return [];
	if (seen.has(value)) return [];
	seen.add(value);
	const out: unknown[] = [];
	if (Array.isArray(value)) {
		for (const item of value) out.push(...collectJobNames(item, depth + 1, seen));
		return out;
	}
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		if (key === "jobName" || key === "job_name" || key === "kubernetesJobName") {
			out.push(nested);
		}
		out.push(...collectJobNames(nested, depth + 1, seen));
	}
	return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
