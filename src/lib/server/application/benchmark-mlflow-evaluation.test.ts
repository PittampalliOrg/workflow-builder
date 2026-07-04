import { describe, expect, it, vi } from "vitest";
import {
	ApplicationBenchmarkMlflowEvaluationService,
	type BenchmarkMlflowEvaluationRepository,
} from "$lib/server/application/benchmark-mlflow-evaluation";

describe("ApplicationBenchmarkMlflowEvaluationService", () => {
	it("rejects requests without a non-empty mlflow eval run id", async () => {
		const repository = fakeRepository();
		const service = new ApplicationBenchmarkMlflowEvaluationService(repository);

		await expect(
			service.recordEvaluation({
				runId: "run-1",
				body: { mlflowEvalRunId: " " },
			}),
		).resolves.toEqual({
			status: "invalid",
			message: "mlflowEvalRunId is required",
		});
		expect(repository.recordEvaluation).not.toHaveBeenCalled();
	});

	it("normalizes request body and delegates persistence to the repository", async () => {
		const repository = fakeRepository();
		const service = new ApplicationBenchmarkMlflowEvaluationService(repository);

		await expect(
			service.recordEvaluation({
				runId: "run-1",
				body: {
					mlflowEvalRunId: " eval-run-1 ",
					summary: { score: 0.75 },
				},
			}),
		).resolves.toEqual({
			status: "recorded",
			record: { mlflowEvalRunId: "eval-run-1" },
		});
		expect(repository.recordEvaluation).toHaveBeenCalledWith({
			runId: "run-1",
			mlflowEvalRunId: "eval-run-1",
			summary: { score: 0.75 },
		});
	});

	it("maps missing benchmark runs to not-found results", async () => {
		const repository = fakeRepository();
		vi.mocked(repository.recordEvaluation).mockResolvedValueOnce(null);
		const service = new ApplicationBenchmarkMlflowEvaluationService(repository);

		await expect(
			service.recordEvaluation({
				runId: "missing",
				body: { mlflowEvalRunId: "eval-run-1" },
			}),
		).resolves.toEqual({
			status: "not_found",
			message: "Benchmark run not found",
		});
	});
});

function fakeRepository(): BenchmarkMlflowEvaluationRepository {
	return {
		recordEvaluation: vi.fn(async ({ mlflowEvalRunId }) => ({
			mlflowEvalRunId,
		})),
	};
}
