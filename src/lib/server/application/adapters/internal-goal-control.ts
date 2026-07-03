import type {
	CompletedWorkflowGoalFinalizerPort,
	GoalCompletionEvaluatorPort,
} from "$lib/server/application/internal-goal-control";
import {
	GoalCompletionEvaluator,
	type GoalCompletionEvaluatorDependencies,
} from "$lib/server/goals/evaluator";
import { finalizeCompletedWorkflowGoal } from "$lib/server/goals/goal-loop";

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
	finalizeCompletedWorkflowGoal(sessionId: string) {
		return finalizeCompletedWorkflowGoal(sessionId);
	}
}
