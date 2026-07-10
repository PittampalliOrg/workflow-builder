import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationInternalGoalControlService,
	type CompletedWorkflowGoalFinalizerPort,
	type GoalCompletionEvaluatorPort,
	type GoalRejectionSourceEventIdPort,
} from "$lib/server/application/internal-goal-control";
import type {
	SessionEventLog,
	SessionGoalLoopDriver,
	SessionGoalRecord,
	SessionGoalStore,
} from "$lib/server/application/ports";

describe("ApplicationInternalGoalControlService", () => {
	let evaluator: GoalCompletionEvaluatorPort;
	let finalizer: CompletedWorkflowGoalFinalizerPort;
	let goals: SessionGoalStore;
	let goalLoop: SessionGoalLoopDriver;
	let sessionEvents: SessionEventLog;
	let rejectionIds: GoalRejectionSourceEventIdPort;
	let service: ApplicationInternalGoalControlService;

	beforeEach(() => {
		evaluator = {
			evaluateGoalCompletion: vi.fn(async () => ({
				met: true,
				skipped: false,
				feedback: "passed",
				results: [],
			})),
		};
		finalizer = {
			finalizeCompletedWorkflowGoal: vi.fn(async () => undefined),
		};
		goals = {
			getCurrentGoal: vi.fn(async () => sampleGoal()),
			createOrReplaceGoal: vi.fn(async () => sampleGoal()),
			markGoalComplete: vi.fn(async () => sampleGoal({ status: "complete" })),
			pauseGoal: vi.fn(async () => sampleGoal({ status: "paused" })),
		};
		goalLoop = {
			kickSessionGoalLoop: vi.fn(async () => undefined),
		};
		sessionEvents = {
			appendSessionEvent: vi.fn(async () => ({}) as never),
			getSessionEvent: vi.fn(async () => null),
			listSessionEvents: vi.fn(async () => []),
			claimUnraisedTeamEvents: vi.fn(async () => []),
			unclaimSessionEvents: vi.fn(async () => {}),
		};
		rejectionIds = {
			nextGoalRejectionSourceEventId: vi.fn(
				() => "goal-rejected:session-1:mcp:123",
			),
		};
		service = new ApplicationInternalGoalControlService({
			evaluator,
			finalizer,
			goals,
			goalLoop,
			sessionEvents,
			rejectionIds,
		});
	});

	it("marks met goals complete and finalizes workflow sessions", async () => {
		const result = await service.evaluateCompletion({ sessionId: "session-1" });

		expect(result).toEqual({
			body: {
				met: true,
				skipped: false,
				feedback: "passed",
				results: [],
			},
		});
		expect(goals.markGoalComplete).toHaveBeenCalledWith("session-1");
		expect(finalizer.finalizeCompletedWorkflowGoal).toHaveBeenCalledWith(
			"session-1",
		);
		expect(sessionEvents.appendSessionEvent).not.toHaveBeenCalled();
	});

	it("records evaluator rejections as session events", async () => {
		vi.mocked(evaluator.evaluateGoalCompletion).mockResolvedValueOnce({
			met: false,
			skipped: false,
			feedback: "tests failed",
			results: [
				{
					command: "pnpm check",
					exitCode: 1,
					ok: false,
					output: "type error",
				},
			],
		});

		const result = await service.evaluateCompletion({ sessionId: "session-1" });

		expect(result.body).toMatchObject({
			met: false,
			skipped: false,
			feedback: "tests failed",
		});
		expect(goals.markGoalComplete).not.toHaveBeenCalled();
		expect(finalizer.finalizeCompletedWorkflowGoal).not.toHaveBeenCalled();
		expect(sessionEvents.appendSessionEvent).toHaveBeenCalledWith("session-1", {
			type: "session.goal_rejected",
			data: {
				feedback: "tests failed",
				iteration: 4,
				results: [
					{
						command: "pnpm check",
						exitCode: 1,
						ok: false,
						output: "type error",
					},
				],
				source: "update_goal",
			},
			processedAt: null,
			sourceEventId: "goal-rejected:session-1:mcp:123",
		});
	});

	it("does not emit rejection events for skipped self-judged completions", async () => {
		vi.mocked(evaluator.evaluateGoalCompletion).mockResolvedValueOnce({
			met: false,
			skipped: true,
			feedback: "skipped",
			results: [],
		});

		await service.evaluateCompletion({ sessionId: "session-1" });

		expect(sessionEvents.appendSessionEvent).not.toHaveBeenCalled();
	});

	it("drives stop-checks through the goal loop and reports current status", async () => {
		const result = await service.stopCheck({ sessionId: "session-1" });

		expect(goalLoop.kickSessionGoalLoop).toHaveBeenCalledWith("session-1", {
			fromStopHook: true,
		});
		expect(goals.getCurrentGoal).toHaveBeenCalledWith("session-1");
		expect(result).toEqual({ body: { goalStatus: "active" } });
	});

	it("keeps stop-check current goal reads best-effort", async () => {
		vi.mocked(goals.getCurrentGoal).mockRejectedValueOnce(new Error("db down"));

		await expect(service.stopCheck({ sessionId: "session-1" })).resolves.toEqual(
			{ body: { goalStatus: null } },
		);
	});

	it("preserves route-safe missing-session responses", async () => {
		await expect(service.evaluateCompletion({ sessionId: "" })).resolves.toEqual({
			httpStatus: 400,
			body: { met: false, feedback: "sessionId required" },
		});
		await expect(service.stopCheck({ sessionId: "" })).resolves.toEqual({
			httpStatus: 400,
			body: { error: "sessionId required" },
		});
	});
});

function sampleGoal(
	overrides: Partial<SessionGoalRecord> = {},
): SessionGoalRecord {
	return {
		id: "goal-row-1",
		sessionId: "session-1",
		goalId: "goal-1",
		objective: "ship it",
		status: "active",
		tokenBudget: null,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		iterations: 4,
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
