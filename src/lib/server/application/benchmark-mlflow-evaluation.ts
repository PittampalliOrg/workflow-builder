export type BenchmarkMlflowEvaluationRecord = {
	mlflowEvalRunId: string;
};

export type BenchmarkMlflowEvaluationRepository = {
	recordEvaluation(input: {
		runId: string;
		mlflowEvalRunId: string;
		summary: Record<string, unknown> | null;
	}): Promise<BenchmarkMlflowEvaluationRecord | null>;
};

export type RecordBenchmarkMlflowEvaluationResult =
	| { status: "recorded"; record: BenchmarkMlflowEvaluationRecord }
	| { status: "invalid"; message: string }
	| { status: "not_found"; message: string };

export class ApplicationBenchmarkMlflowEvaluationService {
	constructor(private readonly repository: BenchmarkMlflowEvaluationRepository) {}

	async recordEvaluation(input: {
		runId: string;
		body: Record<string, unknown>;
	}): Promise<RecordBenchmarkMlflowEvaluationResult> {
		const mlflowEvalRunId =
			typeof input.body.mlflowEvalRunId === "string"
				? input.body.mlflowEvalRunId.trim()
				: "";
		if (!mlflowEvalRunId) {
			return { status: "invalid", message: "mlflowEvalRunId is required" };
		}
		const summary = isRecord(input.body.summary) ? input.body.summary : null;
		const record = await this.repository.recordEvaluation({
			runId: input.runId,
			mlflowEvalRunId,
			summary,
		});
		if (!record) {
			return { status: "not_found", message: "Benchmark run not found" };
		}
		return { status: "recorded", record };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
