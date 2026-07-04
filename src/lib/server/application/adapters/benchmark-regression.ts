import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { benchmarkRunInstances } from "$lib/server/db/schema";
import {
	compareRunMetrics,
	type RegressionTest,
	type RunInstanceMetrics,
} from "$lib/server/benchmarks/regression";

async function loadRunInstanceMetrics(runId: string): Promise<RunInstanceMetrics[]> {
	if (!db) throw new Error("Database not configured");
	const rows = await db
		.select({
			status: benchmarkRunInstances.status,
			turnCount: benchmarkRunInstances.turnCount,
			toolCallCount: benchmarkRunInstances.toolCallCount,
			usage: benchmarkRunInstances.usage,
			ttftFirstMs: benchmarkRunInstances.ttftFirstMs,
		})
		.from(benchmarkRunInstances)
		.where(eq(benchmarkRunInstances.runId, runId));
	return rows.map((r) => {
		const usage = (r.usage ?? {}) as Record<string, unknown>;
		const inputTokens = Number(usage.input_tokens ?? 0);
		const outputTokens = Number(usage.output_tokens ?? 0);
		const tokens = inputTokens + outputTokens;
		const costUsd = Number(usage.cost_usd ?? 0);
		return {
			resolved: r.status === "resolved",
			turnCount: r.turnCount,
			toolCallCount: r.toolCallCount,
			tokens: tokens > 0 ? tokens : null,
			ttft: r.ttftFirstMs,
			costUsd: costUsd > 0 ? costUsd : null,
		};
	});
}

/**
 * Compare two persisted benchmark runs. Persistence is intentionally confined
 * to this adapter; statistical comparison stays in the benchmark domain module.
 */
export async function compareRuns(
	baselineRunId: string,
	candidateRunId: string,
): Promise<RegressionTest[]> {
	const [baseline, candidate] = await Promise.all([
		loadRunInstanceMetrics(baselineRunId),
		loadRunInstanceMetrics(candidateRunId),
	]);
	return compareRunMetrics(baseline, candidate);
}
