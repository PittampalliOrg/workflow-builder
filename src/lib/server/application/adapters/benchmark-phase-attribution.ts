import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	benchmarkRunInstances,
	benchmarkRuns,
} from "$lib/server/db/schema";
import { computeRunStats } from "$lib/server/application/adapters/benchmark-stats";
import {
	buildBenchmarkRunPhaseAttribution,
	buildRunPhaseAttributionQueryContext,
	type RunPhaseAttribution,
} from "$lib/server/benchmarks/phase-attribution";
import { queryHistogramPercentiles } from "$lib/server/otel/metrics";

const DEFAULT_CLUSTER = process.env.METRICS_DEFAULT_CLUSTER ?? "dev";

export async function getBenchmarkRunPhaseAttribution(
	runId: string,
): Promise<RunPhaseAttribution | null> {
	if (!db) return null;

	const [run] = await db
		.select({
			id: benchmarkRuns.id,
			startedAt: benchmarkRuns.startedAt,
			completedAt: benchmarkRuns.completedAt,
			createdAt: benchmarkRuns.createdAt,
		})
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, runId))
		.limit(1);
	if (!run) return null;

	const instances = await db
		.select({
			instanceId: benchmarkRunInstances.instanceId,
			sandboxName: benchmarkRunInstances.sandboxName,
			sessionId: benchmarkRunInstances.sessionId,
			startedAt: benchmarkRunInstances.startedAt,
			inferenceCompletedAt: benchmarkRunInstances.inferenceCompletedAt,
			evaluatedAt: benchmarkRunInstances.evaluatedAt,
		})
		.from(benchmarkRunInstances)
		.where(eq(benchmarkRunInstances.runId, runId));

	const context = buildRunPhaseAttributionQueryContext(run, instances);

	const queueWaitPromise = context.podNames.length
		? queryHistogramPercentiles(
				"kueue_admission_wait_time_seconds",
				[0.5, 0.95],
				context.range,
				{
					cluster: DEFAULT_CLUSTER,
					attribute: { pod: context.podNames },
				},
			)
		: Promise.resolve(null);

	// Agent-sandbox cold-start latency is not labelled per-pod. We scope to the
	// run's padded window and surface a caveat in the read model when needed.
	const coldStartPromise = queryHistogramPercentiles(
		"agent_sandbox_claim_startup_latency_ms",
		[0.5, 0.95],
		context.range,
		{
			cluster: DEFAULT_CLUSTER,
			attribute: { launch_type: "cold" },
		},
	);

	const runStatsPromise = computeRunStats(runId).catch(() => null);
	const [queueWait, coldStart, runStats] = await Promise.all([
		queueWaitPromise,
		coldStartPromise,
		runStatsPromise,
	]);

	return buildBenchmarkRunPhaseAttribution({
		runId,
		instances,
		context,
		queueWait,
		coldStart,
		runStats,
		cluster: DEFAULT_CLUSTER,
	});
}
