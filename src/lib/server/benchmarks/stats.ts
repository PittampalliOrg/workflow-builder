// Server-side aggregation: computes the structured statistics surfaced on
// the run-detail page. Reads benchmarkRunInstances joined to
// benchmarkInstances for repo + metadata.difficulty.

import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	benchmarkInstances,
	benchmarkRuns,
	benchmarkRunInstances,
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
	tokensTotal: number;
	tokensInTotal: number;
	tokensOutTotal: number;
	costUsdTotal: number;
	inferenceDurationMs: DurationPercentiles;
	failureCategoryCounts: Record<FailureCategory, number>;
	cumulativeResolved: CumulativePoint[];
};

const DIFFICULTY_BUCKETS = ['<15min', '15min-1h', '1h-4h', '>4h'];

function asNumber(v: unknown): number {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string' && Number.isFinite(Number(v))) return Number(v);
	return 0;
}

function readUsageNumbers(usage: Record<string, unknown> | null | undefined) {
	if (!usage) return { tokens: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
	const tokensIn = asNumber(
		usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens,
	);
	const tokensOut = asNumber(
		usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens,
	);
	const totalDirect = asNumber(usage.total_tokens ?? usage.totalTokens);
	const tokens = totalDirect > 0 ? totalDirect : tokensIn + tokensOut;
	const cost = asNumber(usage.cost_usd ?? usage.costUsd ?? usage.cost);
	return { tokens, tokensIn, tokensOut, cost };
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
			repo: benchmarkInstances.repo,
			metadata: benchmarkInstances.metadata,
		})
		.from(benchmarkRunInstances)
		.leftJoin(
			benchmarkInstances,
			and(
				eq(benchmarkInstances.instanceId, benchmarkRunInstances.instanceId),
				eq(benchmarkRuns.suiteId, benchmarkInstances.suiteId),
			),
		)
		.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
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
	let costUsdTotal = 0;

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
		costUsdTotal += usage.cost;

		const dur = inferenceDurationMs({
			startedAt: row.startedAt,
			inferenceCompletedAt: row.inferenceCompletedAt,
			timings: row.timings as Record<string, unknown>,
		});
		if (dur != null) inferenceDurations.push(dur);

		if (row.evaluatedAt) {
			cumulative.push({ ts: row.evaluatedAt.getTime(), resolved: isResolved });
		}

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

	return {
		resolved,
		total,
		resolvedRate: total > 0 ? resolved / total : 0,
		byRepo,
		byDifficulty,
		byStatus,
		tokensTotal,
		tokensInTotal,
		tokensOutTotal,
		costUsdTotal,
		inferenceDurationMs: inferenceDurationMsStats,
		failureCategoryCounts: aggregateFailureCategories(parsedHarness),
		cumulativeResolved,
	};
}
