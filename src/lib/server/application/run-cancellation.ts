import type {
	BenchmarkRunCancellationPort,
	EvaluationRunCancellationPort,
} from "$lib/server/application/ports";

export type CoordinatorRunKind = "benchmarkRun" | "evalRun";

export type CoordinatorCancelMode = "background" | "sync";

export type CoordinatorCancelInput = {
	kind: CoordinatorRunKind;
	runId: string;
	reason: string;
	mode: CoordinatorCancelMode;
};

export type CoordinatorCancelResult = {
	scheduled: boolean;
	error: string | null;
};

export type CoordinatorCancelPort = {
	cancelRun(input: CoordinatorCancelInput): Promise<CoordinatorCancelResult>;
};

export type RunCancellationResult =
	| { status: "ok"; body: Record<string, unknown> }
	| { status: "not_found"; message: string };

export class ApplicationRunCancellationService {
	constructor(
		private readonly deps: {
			benchmarkRuns: BenchmarkRunCancellationPort;
			evaluationRuns: EvaluationRunCancellationPort;
			coordinator: CoordinatorCancelPort;
		},
	) {}

	async cancelBenchmarkRun(input: {
		projectId?: string | null;
		runId: string;
	}): Promise<RunCancellationResult> {
		if (!input.projectId) return benchmarkNotFound();

		const run = await this.deps.benchmarkRuns.cancelBenchmarkRun(
			input.projectId,
			input.runId,
			{ terminalCleanup: "background" },
		);
		if (!run) return benchmarkNotFound();

		const coordinator = await this.deps.coordinator.cancelRun({
			kind: "benchmarkRun",
			runId: input.runId,
			reason: "cancelled by user",
			mode: "background",
		});

		return {
			status: "ok",
			body: {
				run,
				coordinatorCancelScheduled: coordinator.scheduled,
			},
		};
	}

	async cancelEvaluationRun(input: {
		projectId?: string | null;
		runId: string;
	}): Promise<RunCancellationResult> {
		if (!input.projectId) return evaluationNotFound();

		const run = await this.deps.evaluationRuns.cancelEvaluationRun(
			input.projectId,
			input.runId,
		);
		const coordinator = await this.deps.coordinator.cancelRun({
			kind: "evalRun",
			runId: input.runId,
			reason: "cancelled by user",
			mode: "sync",
		});

		return {
			status: "ok",
			body: {
				run,
				coordinatorCancelError: coordinator.error,
			},
		};
	}
}

function benchmarkNotFound(): RunCancellationResult {
	return { status: "not_found", message: "Benchmark run not found" };
}

function evaluationNotFound(): RunCancellationResult {
	return { status: "not_found", message: "Evaluation run not found" };
}
