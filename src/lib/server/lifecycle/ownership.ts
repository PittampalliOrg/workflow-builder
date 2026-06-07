import { eq, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import { benchmarkRunInstances, evaluationRunItems } from "$lib/server/db/schema";

export type DurableRunOwner = { kind: "benchmarkRun" | "evalRun"; runId: string };

/**
 * If a workflow execution (looked up by execution id OR its Dapr instance id) is
 * actually a benchmark/eval INSTANCE driven by a higher-level coordinator, return
 * its owning run.
 *
 * Stopping such an execution via the generic per-execution Stop is futile — the
 * coordinator's poll loop re-drives an instance whose DB row isn't terminal, so a
 * fresh execution reappears. The single stop authority for these is the owning
 * RUN's cancel surface; callers must redirect there rather than fight the
 * coordinator. (The reaper still reconciles a genuinely terminal/gone orphan via
 * stopDurableRun directly — this guard is only for the user-facing stop route.)
 */
export async function ownsBenchmarkOrEvalRun(
	executionIdOrInstanceId: string,
): Promise<DurableRunOwner | null> {
	const database = db;
	const id = executionIdOrInstanceId?.trim();
	if (!database || !id) return null;
	const [bench] = await database
		.select({ runId: benchmarkRunInstances.runId })
		.from(benchmarkRunInstances)
		.where(
			or(
				eq(benchmarkRunInstances.workflowExecutionId, id),
				eq(benchmarkRunInstances.daprInstanceId, id),
			),
		)
		.limit(1);
	if (bench?.runId) return { kind: "benchmarkRun", runId: bench.runId };
	const [evalItem] = await database
		.select({ runId: evaluationRunItems.runId })
		.from(evaluationRunItems)
		.where(
			or(
				eq(evaluationRunItems.workflowExecutionId, id),
				eq(evaluationRunItems.daprInstanceId, id),
			),
		)
		.limit(1);
	if (evalItem?.runId) return { kind: "evalRun", runId: evalItem.runId };
	return null;
}
