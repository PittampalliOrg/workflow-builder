import { BenchmarkAgentValidationError } from "$lib/server/benchmarks/agents";
import {
	createBenchmarkRun,
	getBenchmarkRun,
	listBenchmarkRuns,
	markBenchmarkRunStatus,
	startSwebenchCoordinator,
	type CreateBenchmarkRunInput,
} from "$lib/server/application/adapters/benchmark-service";
import {
	createEvaluationRun,
	listEvaluationRuns,
	markEvaluationRunStatus,
	startEvaluationCoordinator,
	type CreateEvaluationRunInput,
	type EvaluationSubjectTypeInput as LegacyEvaluationSubjectTypeInput,
} from "$lib/server/application/adapters/evaluation-service";
import type {
	BenchmarkCreateRunResult,
	BenchmarkRunLaunchCreateInput,
	BenchmarkRunLaunchPort,
	CreatedRun,
	EvaluationRunLaunchCreateInput,
	EvaluationRunLaunchPort,
	EvaluationSubjectTypeInput,
} from "$lib/server/application/run-launch";

export class LegacyBenchmarkRunLaunchAdapter implements BenchmarkRunLaunchPort {
	listRuns(input: {
		projectId: string;
		limit: number;
		tag?: string | null;
	}) {
		return listBenchmarkRuns(input.projectId, input.limit, {
			tag: input.tag ?? null,
		});
	}

	async createRun(
		input: BenchmarkRunLaunchCreateInput,
	): Promise<BenchmarkCreateRunResult> {
		try {
			return {
				status: "ok",
				run: await createBenchmarkRun(input as CreateBenchmarkRunInput),
			};
		} catch (err) {
			if (err instanceof BenchmarkAgentValidationError) {
				return { status: "validation_error", message: err.message };
			}
			throw err;
		}
	}

	startCoordinator(runId: string) {
		return startSwebenchCoordinator(runId);
	}

	markStatus(
		runId: string,
		status: "queued" | "failed",
		extra: Record<string, unknown>,
	) {
		return markBenchmarkRunStatus(runId, status, extra);
	}

	getRun(projectId: string, runId: string) {
		return getBenchmarkRun(projectId, runId);
	}
}

export class LegacyEvaluationRunLaunchAdapter implements EvaluationRunLaunchPort {
	listRuns(projectId: string, limit: number) {
		return listEvaluationRuns(projectId, limit);
	}

	createRun(input: EvaluationRunLaunchCreateInput) {
		return createEvaluationRun({
			...input,
			subjectType: input.subjectType as LegacyEvaluationSubjectTypeInput,
		} satisfies CreateEvaluationRunInput) as Promise<CreatedRun>;
	}

	startCoordinator(runId: string) {
		return startEvaluationCoordinator(runId);
	}

	markStatus(
		runId: string,
		status: "running" | "failed",
		extra: Record<string, unknown>,
	) {
		return markEvaluationRunStatus(runId, status, extra);
	}
}

export type { EvaluationSubjectTypeInput };
