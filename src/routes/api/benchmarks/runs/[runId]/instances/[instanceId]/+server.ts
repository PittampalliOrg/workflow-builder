import { error, json } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	benchmarkInstances,
	benchmarkRuns,
	benchmarkRunInstances,
} from "$lib/server/db/schema";
import { parseHarnessResult } from "$lib/server/benchmarks/harness-result";
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
		.select({ id: benchmarkRuns.id, suiteId: benchmarkRuns.suiteId })
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

	return json({
		runInstance: row.run,
		instance: {
			repo: row.repo,
			baseCommit: row.baseCommit,
			problemStatement: row.problemStatement,
			hintsText: row.hintsText,
			testMetadata: row.testMetadata,
			metadata: row.instanceMetadata,
		},
		goldPatch: row.goldPatch,
		parsedHarness,
	});
};
