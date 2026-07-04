import { error } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	agentVersions,
	agents,
	benchmarkRunInstances,
	benchmarkRuns,
	benchmarkSuites,
} from "$lib/server/db/schema";
import { listBenchmarkRuns } from "$lib/server/benchmarks/service";
import {
	buildAxisDiff,
	durationFor,
	summarizeRunConfig,
	tokenSum,
	type InstanceCell,
	type RunConfigSummary,
} from "$lib/server/benchmarks/comparison";
import { compareRuns } from "$lib/server/application/adapters/benchmark-regression";
import type {
	BenchmarkCompareReadModel,
	BenchmarkRunReadRepository,
	BenchmarkRunSummaryReadModel,
} from "$lib/server/application/ports";

export class LegacyBenchmarkRunReadRepository
	implements BenchmarkRunReadRepository
{
	listRuns(input: {
		projectId: string;
		limit?: number;
		tag?: string | null;
	}): Promise<BenchmarkRunSummaryReadModel[]> {
		return listBenchmarkRuns(input.projectId, input.limit, {
			tag: input.tag,
		});
	}

	loadCompareData(input: {
		projectId: string;
		runIds: string[];
	}): Promise<BenchmarkCompareReadModel> {
		return loadCompareData(input.projectId, input.runIds);
	}
}

async function loadCompareData(
	projectId: string,
	runIds: string[],
): Promise<BenchmarkCompareReadModel> {
	if (!db) throw error(503, "Database not configured");
	const database = db;
	const ids = Array.from(new Set(runIds.map((s) => s.trim()).filter(Boolean)));
	if (ids.length < 2) throw error(400, "Provide at least 2 runs to compare");
	if (ids.length > 4) throw error(400, "Compare supports at most 4 runs");

	const runs: RunConfigSummary[] = [];
	const grid: Record<string, Record<string, InstanceCell>> = {};

	for (const runId of ids) {
		const [row] = await database
			.select({
				run: benchmarkRuns,
				suiteSlug: benchmarkSuites.slug,
				suiteName: benchmarkSuites.name,
				agentName: agents.name,
				agentSlug: agents.slug,
				config: agentVersions.config,
			})
			.from(benchmarkRuns)
			.innerJoin(
				benchmarkSuites,
				eq(benchmarkSuites.id, benchmarkRuns.suiteId),
			)
			.innerJoin(agents, eq(agents.id, benchmarkRuns.agentId))
			.leftJoin(
				agentVersions,
				and(
					eq(agentVersions.agentId, benchmarkRuns.agentId),
					eq(agentVersions.version, benchmarkRuns.agentVersion),
				),
			)
			.where(
				and(
					eq(benchmarkRuns.id, runId),
					eq(benchmarkRuns.projectId, projectId),
				),
			)
			.limit(1);

		if (!row) throw error(404, `Run ${runId} not found`);

		const summary = (row.run.summary ?? {}) as Record<string, unknown>;
		const total =
			typeof summary.total === "number"
				? summary.total
				: Array.isArray(row.run.selectedInstanceIds)
					? row.run.selectedInstanceIds.length
					: 0;
		const resolved = typeof summary.resolved === "number" ? summary.resolved : 0;

		runs.push(
			summarizeRunConfig({
				runId,
				suiteSlug: row.suiteSlug,
				suiteName: row.suiteName,
				createdAt: row.run.createdAt,
				status: row.run.status,
				agent: {
					id: row.run.agentId,
					slug: row.agentSlug ?? null,
					name: row.agentName,
				},
				agentVersion: row.run.agentVersion,
				model: row.run.modelNameOrPath,
				modelLabel: row.run.modelConfigLabel,
				maxTurns: row.run.maxTurns,
				concurrency: row.run.concurrency,
				evaluationConcurrency: row.run.evaluationConcurrency,
				evaluatorResourceClass: row.run.evaluatorResourceClass,
				resolved,
				total,
				config: row.config as Record<string, unknown> | null,
			}),
		);

		const instanceRows = await database
			.select({
				instanceId: benchmarkRunInstances.instanceId,
				status: benchmarkRunInstances.status,
				startedAt: benchmarkRunInstances.startedAt,
				inferenceCompletedAt: benchmarkRunInstances.inferenceCompletedAt,
				usage: benchmarkRunInstances.usage,
				error: benchmarkRunInstances.error,
				sessionId: benchmarkRunInstances.sessionId,
			})
			.from(benchmarkRunInstances)
			.where(eq(benchmarkRunInstances.runId, runId));

		const cells: Record<string, InstanceCell> = {};
		for (const ri of instanceRows) {
			cells[ri.instanceId] = {
				status: ri.status,
				resolved: ri.status === "resolved",
				durationMs: durationFor(ri.startedAt, ri.inferenceCompletedAt),
				tokens: tokenSum(ri.usage as Record<string, unknown> | null),
				error: ri.error,
				sessionId: ri.sessionId,
			};
		}
		grid[runId] = cells;
	}

	const allInstanceIds = [
		...new Set(Object.values(grid).flatMap((m) => Object.keys(m))),
	].sort();
	const sharedInstanceIds = allInstanceIds.filter((id) =>
		runs.every((r) => grid[r.runId]?.[id]),
	);
	const disagreements = sharedInstanceIds.filter((id) => {
		const verdicts = runs.map((r) => grid[r.runId]?.[id]?.resolved);
		return new Set(verdicts).size > 1;
	});

	const axisDiff = buildAxisDiff(runs);

	const regression: BenchmarkCompareReadModel["regression"] = [];
	if (runs.length >= 2) {
		const baselineRunId = runs[0].runId;
		for (let i = 1; i < runs.length; i++) {
			try {
				regression.push(await compareRuns(baselineRunId, runs[i].runId));
			} catch (err) {
				console.warn(
					`[compare] regression test ${baselineRunId} vs ${runs[i].runId} failed:`,
					err,
				);
				regression.push([]);
			}
		}
	}

	return {
		runs,
		axisDiff,
		grid,
		allInstanceIds,
		sharedInstanceIds,
		disagreements,
		regression,
	};
}
