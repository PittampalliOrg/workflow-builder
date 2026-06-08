import { eq, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import { benchmarkRunInstances, evaluationRunItems, sessions } from "$lib/server/db/schema";

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

/**
 * Same single-stop-authority check, keyed by a SESSION id. A benchmark/eval
 * instance's agent runs as a session, so the generic per-session Stop must
 * redirect to the owning run too — mirroring the per-execution stop route. We map
 * the session to its workflow-execution / Dapr-instance id (and the session id
 * itself) and reuse {@link ownsBenchmarkOrEvalRun}.
 */
export async function ownsBenchmarkOrEvalRunForSession(
	sessionId: string,
): Promise<DurableRunOwner | null> {
	const database = db;
	const id = sessionId?.trim();
	if (!database || !id) return null;
	const [s] = await database
		.select({
			workflowExecutionId: sessions.workflowExecutionId,
			daprInstanceId: sessions.daprInstanceId,
		})
		.from(sessions)
		.where(eq(sessions.id, id))
		.limit(1);
	for (const candidate of [s?.workflowExecutionId, s?.daprInstanceId, id]) {
		if (!candidate) continue;
		const owner = await ownsBenchmarkOrEvalRun(candidate);
		if (owner) return owner;
	}
	return null;
}
