// Server-side aggregation: computes the structured statistics surfaced on
// the run-detail page. Reads benchmarkRunInstances joined to
// benchmarkInstances for repo + metadata.difficulty.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	benchmarkInstances,
	benchmarkRunInstanceAnnotations,
	benchmarkRunInstanceScores,
	benchmarkRuns,
	benchmarkRunInstances,
	type BenchmarkInstanceAnnotationVerdict,
} from "$lib/server/db/schema";
import {
	parseHarnessResult,
	aggregateFailureCategories,
	type FailureCategory,
} from "./harness-result";

export type ByRepoStat = {
	repo: string;
	total: number;
	resolved: number;
	resolvedRate: number;
};

export type ByDifficultyStat = {
	bucket: string;
	total: number;
	resolved: number;
	resolvedRate: number;
};

export type ByStatusStat = {
	status: string;
	count: number;
};

export type CumulativePoint = {
	evaluatedAt: string;
	count: number;
};

export type DurationPercentiles = {
	count: number;
	p50: number | null;
	p90: number | null;
	max: number | null;
	mean: number | null;
};

export type RunStats = {
	resolved: number;
	total: number;
	resolvedRate: number;
	byRepo: ByRepoStat[];
	byDifficulty: ByDifficultyStat[] | null;
	byStatus: ByStatusStat[];
	byTool: { tool: string; count: number }[];
	byTerminationReason: { reason: string; count: number }[];
	tokensTotal: number;
	tokensInTotal: number;
	tokensOutTotal: number;
	tokensCacheReadTotal: number;
	tokensCacheCreateTotal: number;
	cacheHitRate: number;
	costUsdTotal: number;
	costPerResolved: number;
	llmCallCount: number;
	turnCountP50: number | null;
	turnCountP90: number | null;
	ttftP50: number | null;
	ttftP90: number | null;
	inferenceDurationMs: DurationPercentiles;
	failureCategoryCounts: Record<FailureCategory, number>;
	cumulativeResolved: CumulativePoint[];
	// Phase G: aggregate per-scorer over the run.
	byScorer: ByScorerStat[];
	// Phase J: per-instance rows for client-side cohort pivots.
	cohortRows: CohortRow[];
	// Phase K: human annotation aggregates + harness disagreement count.
	humanAnnotations: HumanAnnotationStats;
};

export type HumanAnnotationStats = {
	counts: Record<BenchmarkInstanceAnnotationVerdict, number>;
	totalAnnotated: number;
	// Number of distinct instances where (human verdict ∈ {correct,incorrect})
	// disagrees with the harness pass/fail signal. Computed only over instances
	// that have at least one annotation.
	harnessDisagreement: number;
};

export type ByScorerStat = {
	scorer: string;
	version: number;
	count: number;
	mean: number;
	p50: number | null;
	p90: number | null;
};

// Phase J — minimal per-instance row shape, shipped alongside RunStats for
// client-side cohort pivoting. The payload is small (1 row per instance) so
// the UI can switch (dimension, measure) instantly without re-fetching.
export type CohortRow = {
	resolved: boolean;
	repo: string | null;
	difficulty: string | null;
	status: string;
	terminationReason: string | null;
	primaryTool: string | null;
	costUsd: number | null;
	turnCount: number | null;
	tokens: number | null;
	ttftMs: number | null;
	inferenceMs: number | null;
};

export type CohortDimension =
	| 'repo'
	| 'difficulty'
	| 'status'
	| 'termination_reason'
	| 'primary_tool';

export type CohortMeasure =
	| 'resolved_rate'
	| 'count'
	| 'cost_usd_mean'
	| 'cost_per_resolved'
	| 'turn_count_p50'
	| 'tokens_p50'
	| 'ttft_p50'
	| 'inference_ms_p50';

export type PivotBucket = {
	dimension: string;
	count: number;
	value: number | null;
};

export const COHORT_DIMENSIONS: { id: CohortDimension; label: string }[] = [
	{ id: 'repo', label: 'Repo' },
	{ id: 'difficulty', label: 'Difficulty' },
	{ id: 'status', label: 'Status' },
	{ id: 'termination_reason', label: 'Termination reason' },
	{ id: 'primary_tool', label: 'Primary tool' },
];

export const COHORT_MEASURES: { id: CohortMeasure; label: string; format: 'pct' | 'count' | 'usd' | 'tokens' | 'ms' }[] = [
	{ id: 'resolved_rate', label: 'Resolved rate', format: 'pct' },
	{ id: 'count', label: 'Count', format: 'count' },
	{ id: 'cost_usd_mean', label: 'Cost (mean)', format: 'usd' },
	{ id: 'cost_per_resolved', label: 'Cost / resolved', format: 'usd' },
	{ id: 'turn_count_p50', label: 'Turns (p50)', format: 'count' },
	{ id: 'tokens_p50', label: 'Tokens (p50)', format: 'tokens' },
	{ id: 'ttft_p50', label: 'TTFT (p50, ms)', format: 'ms' },
	{ id: 'inference_ms_p50', label: 'Inference (p50, ms)', format: 'ms' },
];

function dimensionValue(row: CohortRow, dim: CohortDimension): string {
	switch (dim) {
		case 'repo':
			return row.repo ?? 'unknown';
		case 'difficulty':
			return row.difficulty ?? '(none)';
		case 'status':
			return row.status;
		case 'termination_reason':
			return row.terminationReason ?? '(none)';
		case 'primary_tool':
			return row.primaryTool ?? '(none)';
	}
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return percentile(sorted, 0.5);
}

export function pivot(
	rows: CohortRow[],
	dimension: CohortDimension,
	measure: CohortMeasure,
): PivotBucket[] {
	const groups = new Map<string, CohortRow[]>();
	for (const row of rows) {
		const key = dimensionValue(row, dimension);
		const arr = groups.get(key);
		if (arr) arr.push(row);
		else groups.set(key, [row]);
	}
	const result: PivotBucket[] = [];
	for (const [key, items] of groups.entries()) {
		const count = items.length;
		let value: number | null = 0;
		switch (measure) {
			case 'resolved_rate': {
				const r = items.filter((i) => i.resolved).length;
				value = count > 0 ? r / count : null;
				break;
			}
			case 'count':
				value = count;
				break;
			case 'cost_usd_mean': {
				const xs = items
					.map((i) => i.costUsd)
					.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
				value = xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
				break;
			}
			case 'cost_per_resolved': {
				const totalCost = items
					.map((i) => i.costUsd ?? 0)
					.reduce((a, b) => a + b, 0);
				const resolvedCount = items.filter((i) => i.resolved).length;
				value = resolvedCount > 0 ? totalCost / resolvedCount : null;
				break;
			}
			case 'turn_count_p50': {
				const xs = items
					.map((i) => i.turnCount)
					.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
				value = median(xs);
				break;
			}
			case 'tokens_p50': {
				const xs = items
					.map((i) => i.tokens)
					.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
				value = median(xs);
				break;
			}
			case 'ttft_p50': {
				const xs = items
					.map((i) => i.ttftMs)
					.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
				value = median(xs);
				break;
			}
			case 'inference_ms_p50': {
				const xs = items
					.map((i) => i.inferenceMs)
					.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
				value = median(xs);
				break;
			}
		}
		result.push({ dimension: key, count, value });
	}
	result.sort((a, b) => {
		if (a.value === null && b.value === null) return b.count - a.count;
		if (a.value === null) return 1;
		if (b.value === null) return -1;
		return b.value - a.value || b.count - a.count;
	});
	return result;
}

const DIFFICULTY_BUCKETS = ['<15min', '15min-1h', '1h-4h', '>4h'];

function asNumber(v: unknown): number {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string' && Number.isFinite(Number(v))) return Number(v);
	return 0;
}

function readUsageNumbers(usage: Record<string, unknown> | null | undefined) {
	if (!usage) {
		return {
			tokens: 0,
			tokensIn: 0,
			tokensOut: 0,
			cacheRead: 0,
			cacheCreate: 0,
			cost: 0,
			llmCalls: 0,
		};
	}
	const tokensIn = asNumber(
		usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens,
	);
	const tokensOut = asNumber(
		usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens,
	);
	const cacheRead = asNumber(
		usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens,
	);
	const cacheCreate = asNumber(
		usage.cache_creation_input_tokens ??
			usage.cacheCreationInputTokens ??
			usage.cacheCreateTokens,
	);
	const totalDirect = asNumber(usage.total_tokens ?? usage.totalTokens);
	const tokens = totalDirect > 0 ? totalDirect : tokensIn + tokensOut;
	const cost = asNumber(usage.cost_usd ?? usage.costUsd ?? usage.cost);
	const llmCalls = asNumber(usage.llm_call_count ?? usage.llmCallCount);
	return { tokens, tokensIn, tokensOut, cacheRead, cacheCreate, cost, llmCalls };
}

function inferenceDurationMs(row: {
	startedAt: Date | null;
	inferenceCompletedAt: Date | null;
	timings: Record<string, unknown>;
}): number | null {
	if (row.startedAt && row.inferenceCompletedAt) {
		const start = row.startedAt.getTime();
		const end = row.inferenceCompletedAt.getTime();
		if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
	}
	const direct = asNumber(row.timings?.inference_ms ?? row.timings?.inferenceMs);
	return direct > 0 ? direct : null;
}

function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
	return sorted[idx];
}

function pickDifficulty(metadata: Record<string, unknown> | null | undefined): string | null {
	if (!metadata) return null;
	const direct = metadata.difficulty;
	if (typeof direct === 'string' && DIFFICULTY_BUCKETS.includes(direct)) return direct;
	if (typeof direct === 'string' && direct.trim()) return direct.trim();
	const annotations = metadata.annotations;
	if (annotations && typeof annotations === 'object' && !Array.isArray(annotations)) {
		const a = annotations as Record<string, unknown>;
		if (typeof a.difficulty === 'string' && a.difficulty.trim()) return a.difficulty.trim();
	}
	return null;
}

export async function computeRunStats(runId: string): Promise<RunStats> {
	if (!db) throw new Error('Database not configured');
	const database = db;

	const [run] = await database
		.select({
			id: benchmarkRuns.id,
			summary: benchmarkRuns.summary,
		})
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

	const total = rows.length;
	const repoCounts = new Map<string, { total: number; resolved: number }>();
	const difficultyCounts = new Map<string, { total: number; resolved: number }>();
	const statusCounts = new Map<string, number>();
	const inferenceDurations: number[] = [];
	const cumulative: { ts: number; resolved: boolean }[] = [];
	const parsedHarness: ReturnType<typeof parseHarnessResult>[] = [];

	let resolved = 0;
	let tokensTotal = 0;
	let tokensInTotal = 0;
	let tokensOutTotal = 0;
	let tokensCacheReadTotal = 0;
	let tokensCacheCreateTotal = 0;
	let costUsdTotal = 0;
	let llmCallCount = 0;
	const toolCounts = new Map<string, number>();
	const terminationCounts = new Map<string, number>();
	const turnCounts: number[] = [];
	const ttfts: number[] = [];
	const cohortRows: CohortRow[] = [];

	for (const row of rows) {
		const isResolved = row.status === 'resolved';
		if (isResolved) resolved += 1;
		statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);

		const repo = row.repo ?? 'unknown';
		const repoBucket = repoCounts.get(repo) ?? { total: 0, resolved: 0 };
		repoBucket.total += 1;
		if (isResolved) repoBucket.resolved += 1;
		repoCounts.set(repo, repoBucket);

		const diff = pickDifficulty(row.metadata as Record<string, unknown> | null);
		if (diff) {
			const bucket = difficultyCounts.get(diff) ?? { total: 0, resolved: 0 };
			bucket.total += 1;
			if (isResolved) bucket.resolved += 1;
			difficultyCounts.set(diff, bucket);
		}

		const usage = readUsageNumbers(row.usage as Record<string, unknown> | null);
		tokensTotal += usage.tokens;
		tokensInTotal += usage.tokensIn;
		tokensOutTotal += usage.tokensOut;
		tokensCacheReadTotal += usage.cacheRead;
		tokensCacheCreateTotal += usage.cacheCreate;
		costUsdTotal += usage.cost;
		llmCallCount += usage.llmCalls;

		const dur = inferenceDurationMs({
			startedAt: row.startedAt,
			inferenceCompletedAt: row.inferenceCompletedAt,
			timings: row.timings as Record<string, unknown>,
		});
		if (dur != null) inferenceDurations.push(dur);

		if (row.evaluatedAt) {
			cumulative.push({ ts: row.evaluatedAt.getTime(), resolved: isResolved });
		}

		// Phase B aggregates — turn count P50/P90, termination donut,
		// per-tool histogram across instances, TTFT distribution.
		if (typeof row.turnCount === 'number' && Number.isFinite(row.turnCount)) {
			turnCounts.push(row.turnCount);
		}
		if (typeof row.ttftFirstMs === 'number' && Number.isFinite(row.ttftFirstMs)) {
			ttfts.push(row.ttftFirstMs);
		}
		if (row.terminationReason) {
			terminationCounts.set(
				row.terminationReason,
				(terminationCounts.get(row.terminationReason) ?? 0) + 1,
			);
		}
		const hist = (row.toolHistogram ?? {}) as Record<string, number>;
		let primaryTool: string | null = null;
		let primaryToolCount = 0;
		for (const [tool, count] of Object.entries(hist)) {
			if (!tool) continue;
			const n = asNumber(count);
			toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + n);
			if (n > primaryToolCount) {
				primaryTool = tool;
				primaryToolCount = n;
			}
		}

		cohortRows.push({
			resolved: isResolved,
			repo: row.repo ?? null,
			difficulty: diff ?? null,
			status: row.status,
			terminationReason: row.terminationReason ?? null,
			primaryTool,
			costUsd: usage.cost > 0 ? usage.cost : null,
			turnCount: typeof row.turnCount === 'number' && Number.isFinite(row.turnCount) ? row.turnCount : null,
			tokens: usage.tokens > 0 ? usage.tokens : null,
			ttftMs:
				typeof row.ttftFirstMs === 'number' && Number.isFinite(row.ttftFirstMs)
					? row.ttftFirstMs
					: null,
			inferenceMs: dur ?? null,
		});

		parsedHarness.push(parseHarnessResult(row.harnessResult));
	}

	const byRepo: ByRepoStat[] = [...repoCounts.entries()]
		.map(([repo, c]) => ({
			repo,
			total: c.total,
			resolved: c.resolved,
			resolvedRate: c.total > 0 ? c.resolved / c.total : 0,
		}))
		.sort((a, b) => b.total - a.total || a.repo.localeCompare(b.repo));

	const byDifficulty: ByDifficultyStat[] | null = difficultyCounts.size
		? [...difficultyCounts.entries()]
				.map(([bucket, c]) => ({
					bucket,
					total: c.total,
					resolved: c.resolved,
					resolvedRate: c.total > 0 ? c.resolved / c.total : 0,
				}))
				.sort((a, b) => {
					const ai = DIFFICULTY_BUCKETS.indexOf(a.bucket);
					const bi = DIFFICULTY_BUCKETS.indexOf(b.bucket);
					if (ai !== -1 && bi !== -1) return ai - bi;
					if (ai === -1) return 1;
					if (bi === -1) return -1;
					return a.bucket.localeCompare(b.bucket);
				})
		: null;

	const byStatus: ByStatusStat[] = [...statusCounts.entries()]
		.map(([status, count]) => ({ status, count }))
		.sort((a, b) => b.count - a.count);

	inferenceDurations.sort((a, b) => a - b);
	const inferenceDurationMsStats: DurationPercentiles = {
		count: inferenceDurations.length,
		p50: percentile(inferenceDurations, 0.5),
		p90: percentile(inferenceDurations, 0.9),
		max: inferenceDurations.length ? inferenceDurations[inferenceDurations.length - 1] : null,
		mean:
			inferenceDurations.length > 0
				? inferenceDurations.reduce((a, b) => a + b, 0) / inferenceDurations.length
				: null,
	};

	const cumulativeResolved: CumulativePoint[] = (() => {
		cumulative.sort((a, b) => a.ts - b.ts);
		let count = 0;
		return cumulative
			.filter((c) => c.resolved)
			.map((c) => {
				count += 1;
				return { evaluatedAt: new Date(c.ts).toISOString(), count };
			});
	})();

	// Cache-hit % is "cached input as a fraction of total input touched". The
	// denominator includes both fresh input AND prior-cached input read this
	// run (Anthropic's prompt caching meaningfully reduces cost only when
	// cache_read >> cache_creation; we surface the read-fraction).
	const totalInputForCache = tokensInTotal + tokensCacheReadTotal;
	const cacheHitRate = totalInputForCache > 0 ? tokensCacheReadTotal / totalInputForCache : 0;
	// $ per resolved is the canonical SWE-bench ROI metric (HAL/SWE-rebench).
	// Fall back to 0 when nothing resolved yet — UI guards on `resolved > 0`
	// to render "—" rather than "$0.00 / 0 resolved".
	const costPerResolved = resolved > 0 ? costUsdTotal / resolved : 0;

	turnCounts.sort((a, b) => a - b);
	ttfts.sort((a, b) => a - b);
	const byTool = [...toolCounts.entries()]
		.map(([tool, count]) => ({ tool, count }))
		.sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
	const byTerminationReason = [...terminationCounts.entries()]
		.map(([reason, count]) => ({ reason, count }))
		.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

	// Phase G — scorer aggregates. Loaded as a separate query (no per-instance
	// join in the main loop because most rows have many scores; nested arrays
	// make the row-list query bloated).
	const instanceIds = rows.map((r) => r.id);
	const byScorer: ByScorerStat[] = [];
	if (instanceIds.length > 0) {
		const scoreRows = await database
			.select({
				scorerName: benchmarkRunInstanceScores.scorerName,
				scorerVersion: benchmarkRunInstanceScores.scorerVersion,
				score: benchmarkRunInstanceScores.score,
			})
			.from(benchmarkRunInstanceScores)
			.where(inArray(benchmarkRunInstanceScores.runInstanceId, instanceIds));
		const scoresByName = new Map<string, { version: number; values: number[] }>();
		for (const sr of scoreRows) {
			const key = `${sr.scorerName}:${sr.scorerVersion}`;
			let bucket = scoresByName.get(key);
			if (!bucket) {
				bucket = { version: sr.scorerVersion, values: [] };
				scoresByName.set(key, bucket);
			}
			bucket.values.push(Number(sr.score));
		}
		for (const [key, bucket] of scoresByName.entries()) {
			const [scorer] = key.split(":");
			const sorted = [...bucket.values].sort((a, b) => a - b);
			const sum = bucket.values.reduce((a, b) => a + b, 0);
			byScorer.push({
				scorer,
				version: bucket.version,
				count: bucket.values.length,
				mean: bucket.values.length > 0 ? sum / bucket.values.length : 0,
				p50: percentile(sorted, 0.5),
				p90: percentile(sorted, 0.9),
			});
		}
		byScorer.sort((a, b) => a.scorer.localeCompare(b.scorer));
	}

	// Phase K — aggregate human annotations + compute harness-vs-human
	// disagreement. We pull all annotation rows for this run's instances and
	// fold them into the summary; per-instance rendering happens in the
	// drawer/trace footer via the dedicated annotations endpoint.
	const humanCounts: Record<BenchmarkInstanceAnnotationVerdict, number> = {
		correct: 0,
		incorrect: 0,
		partial: 0,
		unsure: 0,
	};
	let harnessDisagreement = 0;
	const totalAnnotatedSet = new Set<string>();
	if (instanceIds.length > 0) {
		const annotationRows = await database
			.select({
				runInstanceId: benchmarkRunInstanceAnnotations.runInstanceId,
				verdict: benchmarkRunInstanceAnnotations.verdict,
			})
			.from(benchmarkRunInstanceAnnotations)
			.where(inArray(benchmarkRunInstanceAnnotations.runInstanceId, instanceIds));
		const harnessByInstance = new Map<string, boolean>();
		for (const r of rows) harnessByInstance.set(r.id, r.status === 'resolved');
		for (const ann of annotationRows) {
			const verdict = ann.verdict as BenchmarkInstanceAnnotationVerdict;
			humanCounts[verdict] += 1;
			totalAnnotatedSet.add(ann.runInstanceId);
			const passed = harnessByInstance.get(ann.runInstanceId);
			if (verdict === 'correct' && passed === false) harnessDisagreement += 1;
			else if (verdict === 'incorrect' && passed === true) harnessDisagreement += 1;
		}
	}
	const humanAnnotations: HumanAnnotationStats = {
		counts: humanCounts,
		totalAnnotated: totalAnnotatedSet.size,
		harnessDisagreement,
	};

	return {
		resolved,
		total,
		resolvedRate: total > 0 ? resolved / total : 0,
		byRepo,
		byDifficulty,
		byStatus,
		byTool,
		byTerminationReason,
		tokensTotal,
		tokensInTotal,
		tokensOutTotal,
		tokensCacheReadTotal,
		tokensCacheCreateTotal,
		cacheHitRate,
		costUsdTotal,
		costPerResolved,
		llmCallCount,
		turnCountP50: percentile(turnCounts, 0.5),
		turnCountP90: percentile(turnCounts, 0.9),
		ttftP50: percentile(ttfts, 0.5),
		ttftP90: percentile(ttfts, 0.9),
		inferenceDurationMs: inferenceDurationMsStats,
		failureCategoryCounts: aggregateFailureCategories(parsedHarness),
		cumulativeResolved,
		byScorer,
		cohortRows,
		humanAnnotations,
	};
}
