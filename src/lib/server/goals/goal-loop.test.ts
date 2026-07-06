import { describe, expect, it, vi } from "vitest";
import type { GoalLoopStore } from "$lib/server/application/ports";
import { onSessionEvent } from "./goal-loop";

/**
 * A complete GoalLoopStore mock whose getters return "nothing to do" defaults,
 * so `driveContinuationIfIdle` short-circuits harmlessly if the reason gate is
 * (wrongly) passed. Any drive attempt therefore shows up as a call to
 * `hasGoalCompletedEvent` / `getDrivableGoal` — the first store methods the
 * status_idle drive path touches.
 */
function fakeGoalLoopStore(): GoalLoopStore {
	return {
		getCurrentGoal: vi.fn(async () => null),
		getDrivableGoal: vi.fn(async () => null),
		accrueUsage: vi.fn(async () => null),
		claimNextContinuation: vi.fn(async () => null),
		claimIterationCap: vi.fn(async () => null),
		claimBudgetSteer: vi.fn(async () => null),
		markGoalComplete: vi.fn(async () => null),
		pauseGoal: vi.fn(async () => null),
		latestEventMeta: vi.fn(async () => null),
		hasGoalCompletedEvent: vi.fn(async () => false),
		sessionStopState: vi.fn(async () => null),
		getSessionWorkflowExecutionId: vi.fn(async () => null),
	};
}

describe("goal-loop error-idle gate", () => {
	it("does NOT drive a continuation for a status_idle with an error stop reason", async () => {
		// The interactive turn.failed edge publishes status_idle{stop_reason:error}.
		// Under an active goal that must NOT auto-continue — the turn failed, so the
		// goal parks until the user intervenes.
		const store = fakeGoalLoopStore();

		await onSessionEvent(
			"session-1",
			{ type: "session.status_idle", data: { stop_reason: { type: "error" } } },
			store,
		);

		// The reason gate returns before any drive work: none of the drive-path
		// store methods are touched.
		expect(store.hasGoalCompletedEvent).not.toHaveBeenCalled();
		expect(store.getDrivableGoal).not.toHaveBeenCalled();
		expect(store.getCurrentGoal).not.toHaveBeenCalled();
	});

	it("enters the drive path for a normal end_turn status_idle", async () => {
		// Contrast: a real end_turn idle passes the gate and reaches the drive path
		// (which then short-circuits because the mock has no drivable goal).
		const store = fakeGoalLoopStore();

		await onSessionEvent(
			"session-1",
			{ type: "session.status_idle", data: { stop_reason: { type: "end_turn" } } },
			store,
		);

		expect(store.hasGoalCompletedEvent).toHaveBeenCalledWith("session-1");
	});
});
