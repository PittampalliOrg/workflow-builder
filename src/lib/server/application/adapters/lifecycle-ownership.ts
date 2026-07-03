import { eq, or } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import {
	benchmarkRunInstances,
	evaluationRunItems,
	sessions,
} from "$lib/server/db/schema";
import { requirePostgresDb } from "$lib/server/application/adapters/postgres";
import type {
	SessionCoordinatorOwner,
	SessionCoordinatorOwnerPort,
	WorkflowExecutionCoordinatorOwner,
	WorkflowExecutionCoordinatorOwnerPort,
} from "$lib/server/application/ports";

type Database = typeof defaultDb;

export class PostgresLifecycleCoordinatorOwnerStore
	implements WorkflowExecutionCoordinatorOwnerPort, SessionCoordinatorOwnerPort
{
	constructor(private readonly getDatabase: () => Database = requirePostgresDb) {}

	/**
	 * If a workflow execution (looked up by execution id OR its Dapr instance id)
	 * is a benchmark/eval INSTANCE driven by a higher-level coordinator, return
	 * its owning run. Generic execution/session Stop must redirect to that run.
	 */
	async getCoordinatorOwner(
		executionIdOrInstanceId: string,
	): Promise<WorkflowExecutionCoordinatorOwner | null> {
		const id = executionIdOrInstanceId?.trim();
		if (!id) return null;

		const database = this.getDatabase();
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
	 * redirect to the owning run too.
	 */
	async getSessionCoordinatorOwner(
		sessionId: string,
	): Promise<SessionCoordinatorOwner | null> {
		const id = sessionId?.trim();
		if (!id) return null;

		const database = this.getDatabase();
		const [session] = await database
			.select({
				workflowExecutionId: sessions.workflowExecutionId,
				daprInstanceId: sessions.daprInstanceId,
			})
			.from(sessions)
			.where(eq(sessions.id, id))
			.limit(1);

		for (const candidate of [
			session?.workflowExecutionId,
			session?.daprInstanceId,
			id,
		]) {
			if (!candidate) continue;
			const owner = await this.getCoordinatorOwner(candidate);
			if (owner?.kind === "benchmarkRun" || owner?.kind === "evalRun") {
				return { kind: owner.kind, runId: owner.runId };
			}
		}
		return null;
	}
}
