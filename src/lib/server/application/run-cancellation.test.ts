import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationRunCancellationService } from "$lib/server/application/run-cancellation";
import type {
	BenchmarkRunCancellationPort,
	EvaluationRunCancellationPort,
} from "$lib/server/application/ports";
import type {
	CoordinatorCancelPort,
	CoordinatorCancelInput,
} from "$lib/server/application/run-cancellation";

describe("ApplicationRunCancellationService", () => {
	let benchmarkRuns: BenchmarkRunCancellationPort;
	let evaluationRuns: EvaluationRunCancellationPort;
	let coordinatorInputs: CoordinatorCancelInput[];
	let coordinator: CoordinatorCancelPort;
	let service: ApplicationRunCancellationService;

	beforeEach(() => {
		benchmarkRuns = {
			cancelBenchmarkRun: vi.fn(async (_projectId, runId) => ({ id: runId })),
		};
		evaluationRuns = {
			cancelEvaluationRun: vi.fn(async (_projectId, runId) => ({ id: runId })),
		};
		coordinatorInputs = [];
		coordinator = {
			cancelRun: vi.fn(async (input) => {
				coordinatorInputs.push(input);
				return { scheduled: true, error: null };
			}),
		};
		service = new ApplicationRunCancellationService({
			benchmarkRuns,
			evaluationRuns,
			coordinator,
		});
	});

	it("cancels benchmark runs and schedules coordinator cancellation in the background", async () => {
		await expect(
			service.cancelBenchmarkRun({ projectId: "project-1", runId: "bench-1" }),
		).resolves.toEqual({
			status: "ok",
			body: {
				run: { id: "bench-1" },
				coordinatorCancelScheduled: true,
			},
		});

		expect(benchmarkRuns.cancelBenchmarkRun).toHaveBeenCalledWith(
			"project-1",
			"bench-1",
			{ terminalCleanup: "background" },
		);
		expect(coordinatorInputs).toEqual([
			{
				kind: "benchmarkRun",
				runId: "bench-1",
				reason: "cancelled by user",
				mode: "background",
			},
		]);
	});

	it("does not schedule coordinator cancellation when a benchmark run is missing", async () => {
		vi.mocked(benchmarkRuns.cancelBenchmarkRun).mockResolvedValueOnce(null);

		await expect(
			service.cancelBenchmarkRun({ projectId: "project-1", runId: "missing" }),
		).resolves.toEqual({
			status: "not_found",
			message: "Benchmark run not found",
		});
		expect(coordinator.cancelRun).not.toHaveBeenCalled();
	});

	it("cancels evaluation runs and preserves coordinator cancellation errors", async () => {
		vi.mocked(coordinator.cancelRun).mockResolvedValueOnce({
			scheduled: true,
			error: "coordinator unavailable",
		});

		await expect(
			service.cancelEvaluationRun({ projectId: "project-1", runId: "eval-1" }),
		).resolves.toEqual({
			status: "ok",
			body: {
				run: { id: "eval-1" },
				coordinatorCancelError: "coordinator unavailable",
			},
		});

		expect(evaluationRuns.cancelEvaluationRun).toHaveBeenCalledWith(
			"project-1",
			"eval-1",
		);
		expect(coordinator.cancelRun).toHaveBeenCalledWith({
			kind: "evalRun",
			runId: "eval-1",
			reason: "cancelled by user",
			mode: "sync",
		});
	});

	it("returns not found before touching ports when project scope is missing", async () => {
		await expect(
			service.cancelBenchmarkRun({ projectId: null, runId: "bench-1" }),
		).resolves.toEqual({
			status: "not_found",
			message: "Benchmark run not found",
		});
		await expect(
			service.cancelEvaluationRun({ projectId: undefined, runId: "eval-1" }),
		).resolves.toEqual({
			status: "not_found",
			message: "Evaluation run not found",
		});

		expect(benchmarkRuns.cancelBenchmarkRun).not.toHaveBeenCalled();
		expect(evaluationRuns.cancelEvaluationRun).not.toHaveBeenCalled();
		expect(coordinator.cancelRun).not.toHaveBeenCalled();
	});
});
