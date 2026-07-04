import type { HeadlampCluster } from "$lib/headlamp/links";
import type { getBenchmarkRun } from "$lib/server/benchmarks/service";
import type { RunStats } from "$lib/server/benchmarks/stats";
import type { getBenchmarkRunCapacityDiagnostics } from "$lib/server/benchmarks/capacity-diagnostics";
import type { RunPhaseAttribution } from "$lib/server/benchmarks/phase-attribution";
import type { RunFailureContext } from "$lib/server/benchmarks/failure-context";

export type BenchmarkRunDetailRun = NonNullable<
	Awaited<ReturnType<typeof getBenchmarkRun>>
>;

export type BenchmarkRunCapacityDiagnostics = Awaited<
	ReturnType<typeof getBenchmarkRunCapacityDiagnostics>
>;

export type BenchmarkRunDetailPageData = {
	runId: string;
	run: BenchmarkRunDetailRun;
	runStats: RunStats;
	capacityDiagnostics: BenchmarkRunCapacityDiagnostics | null;
	phaseAttribution: RunPhaseAttribution | null;
	failureContext: RunFailureContext | null;
	headlampCluster: HeadlampCluster;
};

export type BenchmarkRunDetailApiData = {
	run: BenchmarkRunDetailRun;
	runStats: RunStats | null;
	capacityDiagnostics: BenchmarkRunCapacityDiagnostics | null;
};

export type BenchmarkRunDetailLoadResult =
	| { status: "ok"; data: BenchmarkRunDetailPageData }
	| { status: "not_found"; message: string };

export type BenchmarkRunDetailApiResult =
	| { status: "ok"; body: BenchmarkRunDetailApiData }
	| { status: "not_found"; message: string };

export type BenchmarkRunDetailReadPort = {
	getRun(projectId: string, runId: string): Promise<BenchmarkRunDetailRun | null>;
	computeRunStats(runId: string): Promise<RunStats | null>;
	getCapacityDiagnostics(
		projectId: string,
		runId: string,
	): Promise<BenchmarkRunCapacityDiagnostics | null>;
	getPhaseAttribution(runId: string): Promise<RunPhaseAttribution | null>;
	getFailureContext(
		projectId: string,
		runId: string,
	): Promise<RunFailureContext | null>;
	getHeadlampCluster(): HeadlampCluster;
};

export class ApplicationBenchmarkRunDetailPageService {
	constructor(private readonly readModel: BenchmarkRunDetailReadPort) {}

	async load(input: {
		projectId?: string | null;
		runId: string;
	}): Promise<BenchmarkRunDetailLoadResult> {
		if (!input.projectId) return runNotFound();

		const [
			run,
			runStats,
			capacityDiagnostics,
			phaseAttribution,
			failureContext,
		] = await Promise.all([
			this.readModel.getRun(input.projectId, input.runId),
			this.readModel.computeRunStats(input.runId).catch(() => null),
			this.readModel
				.getCapacityDiagnostics(input.projectId, input.runId)
				.catch(() => null),
			this.readModel.getPhaseAttribution(input.runId).catch(() => null),
			this.readModel
				.getFailureContext(input.projectId, input.runId)
				.catch(() => null),
		]);
		if (!run) return runNotFound();

		return {
			status: "ok",
			data: {
				runId: input.runId,
				run,
				capacityDiagnostics,
				phaseAttribution,
				failureContext,
				headlampCluster: this.readModel.getHeadlampCluster(),
				runStats: runStats ?? emptyRunStats(),
			},
		};
	}

	async getApiDetail(input: {
		projectId?: string | null;
		runId: string;
		includeStats: boolean;
		lite: boolean;
	}): Promise<BenchmarkRunDetailApiResult> {
		if (!input.projectId) return benchmarkRunNotFound();

		const run = await this.readModel.getRun(input.projectId, input.runId);
		if (!run) return benchmarkRunNotFound();

		const [runStats, capacityDiagnostics] = await Promise.all([
			input.includeStats
				? this.readModel.computeRunStats(input.runId)
				: Promise.resolve(null),
			this.readModel
				.getCapacityDiagnostics(input.projectId, input.runId)
				.catch(() => null),
		]);

		return {
			status: "ok",
			body: {
				run: input.lite ? slimRunForApi(run) : run,
				runStats,
				capacityDiagnostics,
			},
		};
	}
}

function runNotFound(): BenchmarkRunDetailLoadResult {
	return { status: "not_found", message: "Run not found" };
}

function benchmarkRunNotFound(): BenchmarkRunDetailApiResult {
	return { status: "not_found", message: "Benchmark run not found" };
}

function slimRunForApi(run: BenchmarkRunDetailRun): BenchmarkRunDetailRun {
	return {
		...run,
		instances: (run.instances ?? []).map((instance) => ({
			...instance,
			harnessResult: null,
			testOutputSummary: null,
		})),
	} as BenchmarkRunDetailRun;
}

function emptyRunStats(): RunStats {
	return {
		resolved: 0,
		total: 0,
		resolvedRate: 0,
		byRepo: [],
		byDifficulty: null,
		byStatus: [],
		byTool: [],
		byTerminationReason: [],
		tokensTotal: 0,
		tokensInTotal: 0,
		tokensOutTotal: 0,
		tokensCacheReadTotal: 0,
		tokensCacheCreateTotal: 0,
		cacheHitRate: 0,
		costUsdTotal: 0,
		costPerResolved: 0,
		llmCallCount: 0,
		turnCountP50: null,
		turnCountP90: null,
		ttftP50: null,
		ttftP90: null,
		byScorer: [],
		inferenceDurationMs: {
			count: 0,
			p50: null,
			p90: null,
			max: null,
			mean: null,
		},
		failureCategoryCounts: {
			resolved: 0,
			unresolved: 0,
			empty_patch: 0,
			patch_apply_failed: 0,
			test_timeout: 0,
			test_failed: 0,
			error: 0,
			timeout: 0,
			unknown: 0,
		},
		cumulativeResolved: [],
		cohortRows: [],
		humanAnnotations: {
			counts: { correct: 0, incorrect: 0, partial: 0, unsure: 0 },
			totalAnnotated: 0,
			harnessDisagreement: 0,
		},
	};
}
