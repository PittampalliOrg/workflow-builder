import { error } from "@sveltejs/kit";
import { getBenchmarkRun } from "$lib/server/benchmarks/service";
import { computeRunStats, type RunStats } from "$lib/server/benchmarks/stats";
import type { PageServerLoad } from "./$types";

export type RunDetailPageData = {
	runId: string;
	run: Awaited<ReturnType<typeof getBenchmarkRun>>;
	runStats: RunStats;
};

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.session?.userId) error(401, "Authentication required");
	if (!locals.session.projectId) error(404, "Run not found");

	const [run, runStats] = await Promise.all([
		getBenchmarkRun(locals.session.projectId, params.runId),
		computeRunStats(params.runId).catch(() => null),
	]);
	if (!run) error(404, "Run not found");

	return {
		runId: params.runId,
		run,
		runStats:
			runStats ??
			({
				resolved: 0,
				total: 0,
				resolvedRate: 0,
				byRepo: [],
				byDifficulty: null,
				byStatus: [],
				tokensTotal: 0,
				tokensInTotal: 0,
				tokensOutTotal: 0,
				costUsdTotal: 0,
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
			} as RunStats),
	};
};
