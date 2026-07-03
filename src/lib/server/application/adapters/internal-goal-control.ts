import type {
	CompletedWorkflowGoalFinalizerPort,
	GoalCompletionEvaluatorPort,
} from "$lib/server/application/internal-goal-control";
import {
	GoalCompletionEvaluator,
	type GoalCompletionEvaluatorDependencies,
} from "$lib/server/goals/evaluator";
import { finalizeCompletedWorkflowGoal } from "$lib/server/goals/goal-loop";
import { PostgresGoalLoopStore } from "$lib/server/application/adapters/goal-loop-store";
import type { GoalLoopStore } from "$lib/server/application/ports";

export class LegacyGoalCompletionEvaluator
	implements GoalCompletionEvaluatorPort
{
	private readonly evaluator: GoalCompletionEvaluator;

	constructor(deps: GoalCompletionEvaluatorDependencies) {
		this.evaluator = new GoalCompletionEvaluator(deps);
	}

	evaluateGoalCompletion(sessionId: string) {
		return this.evaluator.evaluateGoalCompletion(sessionId);
	}
}

export class LegacyCompletedWorkflowGoalFinalizer
	implements CompletedWorkflowGoalFinalizerPort
{
	constructor(
		private readonly goalLoopStore: GoalLoopStore = new PostgresGoalLoopStore(),
	) {}

	finalizeCompletedWorkflowGoal(sessionId: string) {
		return finalizeCompletedWorkflowGoal(sessionId, this.goalLoopStore);
	}
}
