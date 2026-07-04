import { env as privateEnv } from "$env/dynamic/private";
import { and, eq } from "drizzle-orm";
import { normalizeHeadlampCluster } from "$lib/headlamp/links";
import { getBenchmarkRun } from "$lib/server/benchmarks/service";
import { computeRunStats } from "$lib/server/benchmarks/stats";
import { getBenchmarkRunCapacityDiagnostics } from "$lib/server/benchmarks/capacity-diagnostics";
import { getBenchmarkRunPhaseAttribution } from "$lib/server/benchmarks/phase-attribution";
import {
	buildRunFailureContext,
	type RunFailureContext,
	type RunFailureContextSource,
} from "$lib/server/benchmarks/failure-context";
import { db } from "$lib/server/db";
import { benchmarkRuns } from "$lib/server/db/schema";
import type { BenchmarkRunDetailReadPort } from "$lib/server/application/benchmark-run-detail";

export type BenchmarkRunFailureContextRepository = {
	getFailureContextRun(
		projectId: string,
		runId: string,
	): Promise<RunFailureContextSource | null>;
};

export type BuildBenchmarkRunFailureContext = (
	run: RunFailureContextSource,
) => Promise<RunFailureContext | null>;

export class PostgresBenchmarkRunFailureContextRepository
	implements BenchmarkRunFailureContextRepository
{
	constructor(private readonly getDatabase: () => typeof db = () => db) {}

	async getFailureContextRun(
		projectId: string,
		runId: string,
	): Promise<RunFailureContextSource | null> {
		const database = this.getDatabase();
		if (!database) return null;

		const [run] = await database
			.select({
				status: benchmarkRuns.status,
				startedAt: benchmarkRuns.startedAt,
				completedAt: benchmarkRuns.completedAt,
				createdAt: benchmarkRuns.createdAt,
			})
			.from(benchmarkRuns)
			.where(
				and(eq(benchmarkRuns.projectId, projectId), eq(benchmarkRuns.id, runId)),
			)
			.limit(1);
		return run ?? null;
	}
}

export type LegacyBenchmarkRunDetailReadAdapterDeps = {
	failureContextRuns?: BenchmarkRunFailureContextRepository;
	buildFailureContext?: BuildBenchmarkRunFailureContext;
};

export class LegacyBenchmarkRunDetailReadAdapter
	implements BenchmarkRunDetailReadPort
{
	private readonly failureContextRuns: BenchmarkRunFailureContextRepository;
	private readonly buildFailureContext: BuildBenchmarkRunFailureContext;

	constructor(deps: LegacyBenchmarkRunDetailReadAdapterDeps = {}) {
		this.failureContextRuns =
			deps.failureContextRuns ?? new PostgresBenchmarkRunFailureContextRepository();
		this.buildFailureContext = deps.buildFailureContext ?? buildRunFailureContext;
	}

	getRun(projectId: string, runId: string) {
		return getBenchmarkRun(projectId, runId);
	}

	computeRunStats(runId: string) {
		return computeRunStats(runId);
	}

	getCapacityDiagnostics(projectId: string, runId: string) {
		return getBenchmarkRunCapacityDiagnostics(projectId, runId);
	}

	getPhaseAttribution(runId: string) {
		return getBenchmarkRunPhaseAttribution(runId);
	}

	async getFailureContext(projectId: string, runId: string) {
		const run = await this.failureContextRuns.getFailureContextRun(
			projectId,
			runId,
		);
		if (!run) return null;
		return this.buildFailureContext(run);
	}

	getHeadlampCluster() {
		return normalizeHeadlampCluster(privateEnv.WORKFLOW_BUILDER_ENV);
	}
}
