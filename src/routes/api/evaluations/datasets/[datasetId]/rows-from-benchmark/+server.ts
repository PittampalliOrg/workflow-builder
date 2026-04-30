// Phase H — promote a benchmark run instance into a dataset row, preserving
// a bidirectional `origin_run_instance_id` pointer back to the source.
// Body: { runId: string, instanceId: string }
//
// The dataset row's `input` captures the SWE-bench problem identity; `expected`
// captures the harness-graded outcome plus the patch metrics from Phase C —
// enough for a future eval to assert the agent should reach the same patch
// quality on the same problem.

import { error, json } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import type { RequestHandler } from "./$types";
import { db } from "$lib/server/db";
import {
	benchmarkInstances,
	benchmarkRuns,
	benchmarkRunInstances,
} from "$lib/server/db/schema";
import { createEvaluationDatasetRows } from "$lib/server/evaluations/service";

export const POST: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Evaluation dataset not found");
	if (!db) return error(503, "Database not configured");
	const database = db;

	const body = (await request.json().catch(() => ({}))) as {
		runId?: string;
		instanceId?: string;
	};
	const runId = body.runId?.trim();
	const instanceId = body.instanceId?.trim();
	if (!runId || !instanceId) {
		return error(400, "runId and instanceId are required");
	}

	const [row] = await database
		.select({
			runInstance: benchmarkRunInstances,
			suiteId: benchmarkRuns.suiteId,
			projectId: benchmarkRuns.projectId,
			problemStatement: benchmarkInstances.problemStatement,
			repo: benchmarkInstances.repo,
			baseCommit: benchmarkInstances.baseCommit,
			hintsText: benchmarkInstances.hintsText,
		})
		.from(benchmarkRunInstances)
		.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
		.leftJoin(
			benchmarkInstances,
			and(
				eq(benchmarkInstances.suiteId, benchmarkRuns.suiteId),
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

	if (!row) return error(404, "Benchmark instance not found in this run");
	if (row.projectId !== locals.session.projectId) {
		return error(403, "Run is in a different workspace");
	}

	const inserted = await createEvaluationDatasetRows(
		locals.session.projectId,
		params.datasetId,
		[
			{
				externalId: instanceId,
				input: {
					instance_id: instanceId,
					repo: row.repo,
					base_commit: row.baseCommit,
					problem_statement: row.problemStatement,
					hints_text: row.hintsText,
				},
				expected_output: {
					harness_resolved: row.runInstance.status === "resolved",
					patch_files_overlap_gold: row.runInstance.patchFilesOverlapGold,
					patch_well_formed: row.runInstance.patchWellFormed,
					patch_added_lines: row.runInstance.patchAddedLines,
					patch_removed_lines: row.runInstance.patchRemovedLines,
				},
				metadata: {
					promotedFromRunId: runId,
					promotedAt: new Date().toISOString(),
					suiteId: row.suiteId,
				},
				originRunInstanceId: row.runInstance.id,
				originSessionId: row.runInstance.sessionId,
			},
		],
	);

	return json({ rows: inserted }, { status: 201 });
};
