// Phase attribution: wall-clock breakdown for a benchmark run.
//
// Renders the data behind the "Run-time attribution" waterfall card on the
// run-detail page. Persistence and ClickHouse reads live in the application
// adapter layer; this module owns the windowing and aggregate shaping logic.
//
// Per-pod filtering uses the deterministic sandboxName column on
// benchmark_run_instances, which equals the Sandbox CR name and the agent
// pod name (the agent-sandbox controller spawns one Pod per Sandbox with
// the same name).

import type { RunStats } from "$lib/server/benchmarks/stats";

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

export type RunPhaseAttributionRunRow = {
	id: string;
	startedAt: Date | null;
	completedAt: Date | null;
	createdAt: Date;
};

export type RunPhaseAttributionInstanceRow = {
	instanceId: string;
	sandboxName: string | null;
	sessionId: string | null;
	startedAt: Date | null;
	inferenceCompletedAt: Date | null;
	evaluatedAt: Date | null;
};

export type RunPhaseAttributionMetric = {
	count: number;
	percentiles: Record<string, number>;
} | null;

export type RunPhaseAttributionQueryContext = {
	range: { from: Date; to: Date };
	podNames: string[];
};

/** Convert seconds (Kueue native) to ms; null if no count. */
function secondsToMsOrNull(seconds: number, count: number): number | null {
	if (!Number.isFinite(seconds) || count <= 0) return null;
	return seconds * 1000;
}

function msOrNull(value: number, count: number): number | null {
	if (!Number.isFinite(value) || count <= 0) return null;
	return value;
}

export function buildRunPhaseAttributionQueryContext(
	run: RunPhaseAttributionRunRow,
	instances: RunPhaseAttributionInstanceRow[],
	now = new Date(),
): RunPhaseAttributionQueryContext {
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
		now;
	const range = {
		from: new Date(anchorStart.getTime() - 60_000),
		to: new Date(anchorEnd.getTime() + 30_000),
	};

	const podNames = instances
		.map((i) => i.sandboxName)
		.filter((n): n is string => typeof n === "string" && n.length > 0);

	return { range, podNames };
}

export function buildBenchmarkRunPhaseAttribution(input: {
	runId: string;
	instances: RunPhaseAttributionInstanceRow[];
	context: RunPhaseAttributionQueryContext;
	queueWait: RunPhaseAttributionMetric;
	coldStart: RunPhaseAttributionMetric;
	runStats: Pick<RunStats, "inferenceDurationMs"> | null;
	cluster: string | null;
}): RunPhaseAttribution {
	// Inference: from existing RunStats (already in ms).
	const inferenceP50 = input.runStats?.inferenceDurationMs.p50 ?? null;
	const inferenceP95 = input.runStats?.inferenceDurationMs.p90 ?? null;
	const inferenceSamples = input.runStats?.inferenceDurationMs.count ?? 0;

	// Evaluation: best-effort from per-instance (evaluatedAt - inferenceCompletedAt).
	// Only useful if both timestamps are present; histogram size is small enough
	// to compute percentiles in TS.
	const evalDurations: number[] = [];
	for (const inst of input.instances) {
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
		queueWaitP50Ms: input.queueWait
			? secondsToMsOrNull(input.queueWait.percentiles.p50, input.queueWait.count)
			: null,
		queueWaitP95Ms: input.queueWait
			? secondsToMsOrNull(input.queueWait.percentiles.p95, input.queueWait.count)
			: null,
		queueWaitSamples: input.queueWait?.count ?? 0,
		coldStartP50Ms: input.coldStart
			? msOrNull(input.coldStart.percentiles.p50, input.coldStart.count)
			: null,
		coldStartP95Ms: input.coldStart
			? msOrNull(input.coldStart.percentiles.p95, input.coldStart.count)
			: null,
		coldStartSamples: input.coldStart?.count ?? 0,
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
		aggregate.coldStartSamples > 0 && input.context.podNames.length > 1
			? "Sandbox cold-start metrics are not labelled per-pod; values cover the run's full window across all instances."
			: null;

	return {
		runId: input.runId,
		windowFrom: input.context.range.from.toISOString(),
		windowTo: input.context.range.to.toISOString(),
		instanceCount: input.instances.length,
		hasMetricsCoverage,
		cluster: input.cluster,
		caveat,
		aggregate,
	};
}
