import type {
	CompletedWorkflowGoalFinalizerPort,
	GoalCompletionEvaluatorPort,
} from "$lib/server/application/internal-goal-control";
import { evaluateGoalCompletion } from "$lib/server/goals/evaluator";
import { finalizeCompletedWorkflowGoal } from "$lib/server/goals/goal-loop";

export class LegacyGoalCompletionEvaluator
	implements GoalCompletionEvaluatorPort
{
	evaluateGoalCompletion(sessionId: string) {
		return evaluateGoalCompletion(sessionId);
	}
}

export class LegacyCompletedWorkflowGoalFinalizer
	implements CompletedWorkflowGoalFinalizerPort
{
	finalizeCompletedWorkflowGoal(sessionId: string) {
		return finalizeCompletedWorkflowGoal(sessionId);
	}
}
