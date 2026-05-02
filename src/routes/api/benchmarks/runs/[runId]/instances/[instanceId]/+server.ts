import { error, json } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { publicSwebenchTestMetadata } from "$lib/server/benchmarks/contamination";
import {
	benchmarkInstances,
	benchmarkRuns,
	benchmarkRunInstances,
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
		})
		.from(benchmarkRunInstances)
		.leftJoin(
			benchmarkInstances,
			and(
				eq(benchmarkInstances.suiteId, runRow.suiteId),
				eq(benchmarkInstances.instanceId, benchmarkRunInstances.instanceId),
			),
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

	return json({
		runInstance: {
			...row.run,
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
