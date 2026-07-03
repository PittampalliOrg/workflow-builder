import { getEvaluationRun } from "$lib/server/evaluations/service";
import type {
	EvaluationRunDetailReadPort,
	EvaluationRunItemMode,
} from "$lib/server/application/evaluation-run-detail";

export class LegacyEvaluationRunDetailReadAdapter
	implements EvaluationRunDetailReadPort
{
	getRun(
		projectId: string,
		runId: string,
		options: { itemMode: EvaluationRunItemMode },
	) {
		return getEvaluationRun(projectId, runId, options);
	}
}
