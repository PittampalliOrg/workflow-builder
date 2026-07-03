import { describe, expect, it, vi } from "vitest";
import { PostgresGoalLoopStore } from "$lib/server/application/adapters/goal-loop-store";

describe("PostgresGoalLoopStore", () => {
	it("maps drivable goal rows from the query builder", async () => {
		const database = queuedDatabase({
			select: [[goalRow({ id: "goal-row-1" })]],
		});
		const store = new PostgresGoalLoopStore(() => database as never);

		await expect(store.getDrivableGoal("session-1")).resolves.toMatchObject({
			id: "goal-row-1",
			sessionId: "session-1",
			status: "active",
		});
		expect(database.select).toHaveBeenCalledTimes(1);
	});

	it("maps raw snake-case rows returned by atomic claim SQL", async () => {
		const database = queuedDatabase({
			execute: [[goalSqlRow({ id: "goal-row-2", iterations: 2 })]],
		});
		const store = new PostgresGoalLoopStore(() => database as never);

		await expect(store.claimNextContinuation("session-1")).resolves.toMatchObject({
			id: "goal-row-2",
			sessionId: "session-1",
			iterations: 2,
		});
		expect(database.execute).toHaveBeenCalledTimes(1);
	});

	it("returns latest non-telemetry event metadata for the idle gate", async () => {
		const database = queuedDatabase({
			select: [[{ type: "session.status_idle", ageSeconds: "3.5" }]],
		});
		const store = new PostgresGoalLoopStore(() => database as never);

		await expect(store.latestEventMeta("session-1")).resolves.toEqual({
			type: "session.status_idle",
			ageSeconds: 3.5,
		});
	});
});

function queuedDatabase(results: {
	select?: Array<Array<Record<string, unknown>>>;
	execute?: Array<Array<Record<string, unknown>>>;
}) {
	const selectResults = [...(results.select ?? [])];
	const executeResults = [...(results.execute ?? [])];
	const select = vi.fn(() => {
		const result = selectResults.shift() ?? [];
		const query = {
			from: vi.fn(() => query),
			where: vi.fn(() => query),
			orderBy: vi.fn(() => query),
			limit: vi.fn(async () => result),
		};
		return query;
	});
	const execute = vi.fn(async () => executeResults.shift() ?? []);
	return { select, execute };
}

function goalRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "goal-row",
		sessionId: "session-1",
		goalId: "goal-1",
		objective: "ship it",
		status: "active",
		tokenBudget: null,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		iterations: 1,
		maxIterations: 50,
		acceptanceCriteria: null,
		evidencePlan: null,
		budgetSteeredAt: null,
		lastContinuationAt: null,
		stopReason: null,
		workflowExecutionId: "execution-1",
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-01T00:00:00Z"),
		completedAt: null,
		...overrides,
	};
}

function goalSqlRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "goal-row",
		session_id: "session-1",
		goal_id: "goal-1",
		objective: "ship it",
		status: "active",
		token_budget: null,
		tokens_used: 0,
		time_used_seconds: 0,
		iterations: 1,
		max_iterations: 50,
		acceptance_criteria: null,
		evidence_plan: null,
		budget_steered_at: null,
		last_continuation_at: null,
		stop_reason: null,
		workflow_execution_id: "execution-1",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		completed_at: null,
		...overrides,
	};
}
