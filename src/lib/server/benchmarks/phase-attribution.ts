// Phase attribution: wall-clock breakdown for a benchmark run.
//
// Renders the data behind the "Run-time attribution" waterfall card on the
// run-detail page. Pulls metric data from ClickHouse (Kueue admission wait,
// agent-sandbox cold-start latency) and joins per-instance timings from the
// BFF Postgres for inference + evaluation.
//
// Per-pod filtering uses the deterministic sandboxName column on
// benchmark_run_instances, which equals the Sandbox CR name and the agent
// pod name (the agent-sandbox controller spawns one Pod per Sandbox with
// the same name).

import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	benchmarkRunInstances,
	benchmarkRuns,
} from "$lib/server/db/schema";
import { computeRunStats } from "./stats";
import {
	queryHistogramPercentiles,
	type TimeRange,
} from "$lib/server/otel/metrics";

export type RunPhaseAggregate = {
	/** Queue admission wait, milliseconds. Null if no samples in window. */
	queueWaitP50Ms: number | null;
	queueWaitP95Ms: number | null;
	queueWaitSamples: number;
	/** Sandbox claim/startup latency. Already in milliseconds at the source. */
	coldStartP50Ms: number | null;
	coldStartP95Ms: number | null;
	coldStartSamples: number;
	/** From existing RunStats — inference wall-clock per instance. */
	inferenceP50Ms: number | null;
	inferenceP95Ms: number | null;
	inferenceSamples: number;
	/** Evaluation wall-clock — gap between evaluatedAt and the previous phase. */
	evaluationP50Ms: number | null;
	evaluationP95Ms: number | null;
	evaluationSamples: number;
};

export type RunPhaseAttribution = {
	runId: string;
	windowFrom: string; // ISO timestamp
	windowTo: string;
	instanceCount: number;
	hasMetricsCoverage: boolean;
	cluster: string | null;
	/** Note for the UI when filtering can't be perfectly per-run. */
	caveat: string | null;
	aggregate: RunPhaseAggregate;
};

const DEFAULT_CLUSTER = process.env.METRICS_DEFAULT_CLUSTER ?? "dev";

/** Convert seconds (Kueue native) to ms; null if no count. */
function secondsToMsOrNull(seconds: number, count: number): number | null {
	if (!Number.isFinite(seconds) || count <= 0) return null;
	return seconds * 1000;
}

function msOrNull(value: number, count: number): number | null {
	if (!Number.isFinite(value) || count <= 0) return null;
	return value;
}

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

	// Window: pad both edges so we don't lose admission samples that fired a
	// little before benchmarkRuns.startedAt and eval samples that fired after
	// benchmarkRuns.completedAt.
	const anchorStart =
		run.startedAt ??
		instances.reduce<Date | null>((acc, i) => {
			if (!i.startedAt) return acc;
			return acc && acc.getTime() < i.startedAt.getTime() ? acc : i.startedAt;
		}, null) ??
		run.createdAt;
	const anchorEnd =
		run.completedAt ??
		instances.reduce<Date | null>((acc, i) => {
			const candidate = i.evaluatedAt ?? i.inferenceCompletedAt ?? null;
			if (!candidate) return acc;
			return acc && acc.getTime() > candidate.getTime() ? acc : candidate;
		}, null) ??
		new Date();
	const range: TimeRange = {
		from: new Date(anchorStart.getTime() - 60_000),
		to: new Date(anchorEnd.getTime() + 30_000),
	};

	const podNames = instances
		.map((i) => i.sandboxName)
		.filter((n): n is string => typeof n === "string" && n.length > 0);

	// Per-pod Kueue admission wait. If we have no pod names (run never spawned a
	// sandbox), queueWait stays null.
	const queueWaitPromise = podNames.length
		? queryHistogramPercentiles(
				"kueue_admission_wait_time_seconds",
				[0.5, 0.95],
				range,
				{
					cluster: DEFAULT_CLUSTER,
					attribute: { pod: podNames },
				},
			)
		: Promise.resolve(null);

	// Agent-sandbox cold-start latency — not labelled per-pod, only per
	// sandbox_template + launch_type. We scope to the run's window and the
	// dev cluster, and surface a caveat for the UI.
	const coldStartPromise = queryHistogramPercentiles(
		"agent_sandbox_claim_startup_latency_ms",
		[0.5, 0.95],
		range,
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

	// Inference: from existing RunStats (already in ms).
	const inferenceP50 = runStats?.inferenceDurationMs.p50 ?? null;
	const inferenceP95 = runStats?.inferenceDurationMs.p90 ?? null;
	const inferenceSamples = runStats?.inferenceDurationMs.count ?? 0;

	// Evaluation: best-effort from per-instance (evaluatedAt - inferenceCompletedAt).
	// Only useful if both timestamps are present; histogram size is small enough
	// to compute percentiles in TS.
	const evalDurations: number[] = [];
	for (const inst of instances) {
		if (!inst.evaluatedAt || !inst.inferenceCompletedAt) continue;
		const ms = inst.evaluatedAt.getTime() - inst.inferenceCompletedAt.getTime();
		if (ms >= 0 && Number.isFinite(ms)) evalDurations.push(ms);
	}
	evalDurations.sort((a, b) => a - b);
	const evalP50 =
		evalDurations.length > 0
			? evalDurations[Math.floor(evalDurations.length * 0.5)]
			: null;
	const evalP95 =
		evalDurations.length > 0
			? evalDurations[Math.min(evalDurations.length - 1, Math.floor(evalDurations.length * 0.95))]
			: null;

	const aggregate: RunPhaseAggregate = {
		queueWaitP50Ms: queueWait
			? secondsToMsOrNull(queueWait.percentiles.p50, queueWait.count)
			: null,
		queueWaitP95Ms: queueWait
			? secondsToMsOrNull(queueWait.percentiles.p95, queueWait.count)
			: null,
		queueWaitSamples: queueWait?.count ?? 0,
		coldStartP50Ms: msOrNull(coldStart.percentiles.p50, coldStart.count),
		coldStartP95Ms: msOrNull(coldStart.percentiles.p95, coldStart.count),
		coldStartSamples: coldStart.count,
		inferenceP50Ms: inferenceP50,
		inferenceP95Ms: inferenceP95,
		inferenceSamples,
		evaluationP50Ms: evalP50,
		evaluationP95Ms: evalP95,
		evaluationSamples: evalDurations.length,
	};

	const hasMetricsCoverage =
		(aggregate.queueWaitSamples > 0 ||
			aggregate.coldStartSamples > 0 ||
			aggregate.inferenceSamples > 0 ||
			aggregate.evaluationSamples > 0);

	const caveat =
		aggregate.coldStartSamples > 0 && podNames.length > 1
			? "Sandbox cold-start metrics are not labelled per-pod; values cover the run's full window across all instances."
			: null;

	return {
		runId,
		windowFrom: range.from.toISOString(),
		windowTo: range.to.toISOString(),
		instanceCount: instances.length,
		hasMetricsCoverage,
		cluster: DEFAULT_CLUSTER,
		caveat,
		aggregate,
	};
}
