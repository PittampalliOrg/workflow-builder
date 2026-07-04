import { and, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	benchmarkInstances,
	benchmarkRunInstanceAnnotations,
	benchmarkRunInstanceScores,
	benchmarkRuns,
	benchmarkRunInstances,
} from "$lib/server/db/schema";
import {
	computeRunStatsFromRows,
	type RunStats,
	type RunStatsAnnotationRow,
	type RunStatsInstanceRow,
	type RunStatsScoreRow,
} from "$lib/server/benchmarks/stats";

export async function computeRunStats(runId: string): Promise<RunStats> {
	if (!db) throw new Error("Database not configured");
	const database = db;

	const [run] = await database
		.select({ id: benchmarkRuns.id })
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, runId))
		.limit(1);
	if (!run) throw new Error(`Run not found: ${runId}`);

	const rows = await database
		.select({
			id: benchmarkRunInstances.id,
			instanceId: benchmarkRunInstances.instanceId,
			status: benchmarkRunInstances.status,
			startedAt: benchmarkRunInstances.startedAt,
			inferenceCompletedAt: benchmarkRunInstances.inferenceCompletedAt,
			evaluatedAt: benchmarkRunInstances.evaluatedAt,
			usage: benchmarkRunInstances.usage,
			timings: benchmarkRunInstances.timings,
			harnessResult: benchmarkRunInstances.harnessResult,
			turnCount: benchmarkRunInstances.turnCount,
			terminationReason: benchmarkRunInstances.terminationReason,
			toolHistogram: benchmarkRunInstances.toolHistogram,
			ttftFirstMs: benchmarkRunInstances.ttftFirstMs,
			repo: benchmarkInstances.repo,
			metadata: benchmarkInstances.metadata,
		})
		.from(benchmarkRunInstances)
		// Inner-join benchmarkRuns FIRST so the leftJoin below can reference
		// benchmarkRuns.suiteId. Postgres rejects the leftJoin condition if a
		// table referenced inside it isn't already in the FROM-clause graph.
		.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
		.leftJoin(
			benchmarkInstances,
			and(
				eq(benchmarkInstances.instanceId, benchmarkRunInstances.instanceId),
				eq(benchmarkRuns.suiteId, benchmarkInstances.suiteId),
			),
		)
		.where(eq(benchmarkRunInstances.runId, runId));

	const instanceIds = rows.map((row) => row.id);
	let scoreRows: RunStatsScoreRow[] = [];
	let annotationRows: RunStatsAnnotationRow[] = [];
	if (instanceIds.length > 0) {
		scoreRows = await database
			.select({
				scorerName: benchmarkRunInstanceScores.scorerName,
				scorerVersion: benchmarkRunInstanceScores.scorerVersion,
				score: benchmarkRunInstanceScores.score,
			})
			.from(benchmarkRunInstanceScores)
			.where(inArray(benchmarkRunInstanceScores.runInstanceId, instanceIds));
		annotationRows = await database
			.select({
				runInstanceId: benchmarkRunInstanceAnnotations.runInstanceId,
				verdict: benchmarkRunInstanceAnnotations.verdict,
			})
			.from(benchmarkRunInstanceAnnotations)
			.where(inArray(benchmarkRunInstanceAnnotations.runInstanceId, instanceIds));
	}

	return computeRunStatsFromRows(
		rows as RunStatsInstanceRow[],
		scoreRows,
		annotationRows,
	);
}
