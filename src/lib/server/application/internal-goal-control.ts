import type {
	AppendSessionEventInput,
	SessionEventLog,
	SessionGoalLoopDriver,
	SessionGoalStore,
} from "$lib/server/application/ports";

export type GoalCriterionResult = {
	command: string;
	exitCode: number;
	ok: boolean;
	output: string;
};

export type GoalCompletionEvaluation = {
	met: boolean;
	skipped: boolean;
	results: GoalCriterionResult[];
	feedback: string;
};

export type GoalCompletionEvaluatorPort = {
	evaluateGoalCompletion(sessionId: string): Promise<GoalCompletionEvaluation>;
};

export type CompletedWorkflowGoalFinalizerPort = {
	finalizeCompletedWorkflowGoal(sessionId: string): Promise<void>;
};

export type GoalRejectionSourceEventIdPort = {
	nextGoalRejectionSourceEventId(sessionId: string): string;
};

export type InternalGoalControlResult = {
	httpStatus?: number;
	body: Record<string, unknown>;
};

export class ApplicationInternalGoalControlService {
	constructor(
		private readonly deps: {
			evaluator: GoalCompletionEvaluatorPort;
			finalizer: CompletedWorkflowGoalFinalizerPort;
			goals: SessionGoalStore;
			goalLoop: SessionGoalLoopDriver;
			sessionEvents: SessionEventLog;
			rejectionIds: GoalRejectionSourceEventIdPort;
		},
	) {}

	async evaluateCompletion(input: {
		sessionId?: string | null;
	}): Promise<InternalGoalControlResult> {
		if (!input.sessionId) {
			return {
				httpStatus: 400,
				body: { met: false, feedback: "sessionId required" },
			};
		}

		const verdict = await this.deps.evaluator.evaluateGoalCompletion(
			input.sessionId,
		);

		if (verdict.met) {
			await this.deps.goals.markGoalComplete(input.sessionId);
			await this.deps.finalizer.finalizeCompletedWorkflowGoal(input.sessionId);
		} else if (!verdict.skipped) {
			await this.appendGoalRejected(input.sessionId, verdict);
		}

		return {
			body: {
				met: verdict.met,
				skipped: verdict.skipped,
				feedback: verdict.feedback,
				results: verdict.results,
			},
		};
	}

	async stopCheck(input: {
		sessionId?: string | null;
	}): Promise<InternalGoalControlResult> {
		if (!input.sessionId) {
			return { httpStatus: 400, body: { error: "sessionId required" } };
		}

		await this.deps.goalLoop.kickSessionGoalLoop(input.sessionId, {
			fromStopHook: true,
		});
		const goal = await this.deps.goals
			.getCurrentGoal(input.sessionId)
			.catch(() => null);
		return { body: { goalStatus: goal?.status ?? null } };
	}

	private async appendGoalRejected(
		sessionId: string,
		verdict: GoalCompletionEvaluation,
	) {
		const goal = await this.deps.goals.getCurrentGoal(sessionId);
		const event: AppendSessionEventInput = {
			type: "session.goal_rejected",
			data: {
				feedback: verdict.feedback,
				iteration: goal?.iterations ?? 0,
				results: verdict.results,
				source: "update_goal",
			},
			processedAt: null,
			sourceEventId:
				this.deps.rejectionIds.nextGoalRejectionSourceEventId(sessionId),
		};
		await this.deps.sessionEvents.appendSessionEvent(sessionId, event);
	}
}

export class DateGoalRejectionSourceEventIdPort
	implements GoalRejectionSourceEventIdPort
{
	nextGoalRejectionSourceEventId(sessionId: string): string {
		return `goal-rejected:${sessionId}:mcp:${Date.now()}`;
	}
}
