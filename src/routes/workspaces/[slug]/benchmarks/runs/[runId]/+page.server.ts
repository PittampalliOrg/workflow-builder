import { error } from "@sveltejs/kit";
import { env as privateEnv } from "$env/dynamic/private";
import {
	normalizeHeadlampCluster,
	type HeadlampCluster,
} from "$lib/headlamp/links";
import { getBenchmarkRun } from "$lib/server/benchmarks/service";
import { computeRunStats, type RunStats } from "$lib/server/benchmarks/stats";
import { getBenchmarkRunCapacityDiagnostics } from "$lib/server/benchmarks/capacity-diagnostics";
import {
	getBenchmarkRunPhaseAttribution,
	type RunPhaseAttribution,
} from "$lib/server/benchmarks/phase-attribution";
import {
	getRunFailureContext,
	type RunFailureContext,
} from "$lib/server/benchmarks/failure-context";
import type { PageServerLoad } from "./$types";

export type RunDetailPageData = {
	runId: string;
	run: Awaited<ReturnType<typeof getBenchmarkRun>>;
	runStats: RunStats;
	capacityDiagnostics: Awaited<ReturnType<typeof getBenchmarkRunCapacityDiagnostics>>;
	phaseAttribution: RunPhaseAttribution | null;
	failureContext: RunFailureContext | null;
	headlampCluster: HeadlampCluster;
};

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.session?.userId) error(401, "Authentication required");
	if (!locals.session.projectId) error(404, "Run not found");

	const [
		run,
		runStats,
		capacityDiagnostics,
		phaseAttribution,
		failureContext,
	] = await Promise.all([
		getBenchmarkRun(locals.session.projectId, params.runId),
		computeRunStats(params.runId).catch(() => null),
		getBenchmarkRunCapacityDiagnostics(locals.session.projectId, params.runId).catch(
			() => null,
		),
		// Best-effort: ClickHouse may be unreachable in some envs (e.g., when
		// the dev cluster is down). Don't block the run page on metrics.
		getBenchmarkRunPhaseAttribution(params.runId).catch(() => null),
		getRunFailureContext(params.runId).catch(() => null),
	]);
	if (!run) error(404, "Run not found");

	return {
		runId: params.runId,
		run,
		capacityDiagnostics,
		phaseAttribution,
		failureContext,
		headlampCluster: normalizeHeadlampCluster(privateEnv.WORKFLOW_BUILDER_ENV),
		runStats:
			runStats ??
			({
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
				inferenceDurationMs: { count: 0, p50: null, p90: null, max: null, mean: null },
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
			} as RunStats),
	};
};
