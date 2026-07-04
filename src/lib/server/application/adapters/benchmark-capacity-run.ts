import { error } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { benchmarkRuns } from "$lib/server/db/schema";
import type { BenchmarkRunCapacitySource } from "$lib/server/application/benchmark-capacity-diagnostics";

export async function getBenchmarkRunCapacitySource(
	projectId: string,
	runId: string,
): Promise<BenchmarkRunCapacitySource | null> {
	if (!db) throw error(503, "Database not configured");
	const [run] = await db
		.select({
			id: benchmarkRuns.id,
			status: benchmarkRuns.status,
			agentRuntimeAppId: benchmarkRuns.agentRuntimeAppId,
			summary: benchmarkRuns.summary,
			selectedInstanceIds: benchmarkRuns.selectedInstanceIds,
			concurrency: benchmarkRuns.concurrency,
			evaluationConcurrency: benchmarkRuns.evaluationConcurrency,
			modelNameOrPath: benchmarkRuns.modelNameOrPath,
			modelConfigLabel: benchmarkRuns.modelConfigLabel,
			timeoutSeconds: benchmarkRuns.timeoutSeconds,
		})
		.from(benchmarkRuns)
		.where(and(eq(benchmarkRuns.projectId, projectId), eq(benchmarkRuns.id, runId)))
		.limit(1);
	return run ?? null;
}
