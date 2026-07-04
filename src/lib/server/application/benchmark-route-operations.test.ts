import { describe, expect, it, vi } from "vitest";
import {
	ApplicationBenchmarkRouteOperationsService,
	type BenchmarkRouteOperationsPort,
} from "$lib/server/application/benchmark-route-operations";

describe("ApplicationBenchmarkRouteOperationsService", () => {
	it("delegates benchmark run operations through the port", async () => {
		const operations = createOperations({
			listSuites: vi.fn(async () => [{ slug: "suite-1" }]),
			markStatus: vi.fn(async () => ({ id: "run-1", status: "failed" })),
			buildPredictionsJsonl: vi.fn(async () => "{\"id\":\"1\"}\n"),
		});
		const service = new ApplicationBenchmarkRouteOperationsService(operations);

		await expect(service.listSuites("project-1")).resolves.toEqual([
			{ slug: "suite-1" },
		]);
		await expect(
			service.markStatus("run-1", "failed", { error: "boom" }, {
				terminalCleanup: "background",
			}),
		).resolves.toEqual({ id: "run-1", status: "failed" });
		await expect(
			service.buildPredictionsJsonl("project-1", "run-1"),
		).resolves.toBe("{\"id\":\"1\"}\n");

		expect(operations.listSuites).toHaveBeenCalledWith("project-1");
		expect(operations.markStatus).toHaveBeenCalledWith(
			"run-1",
			"failed",
			{ error: "boom" },
			{ terminalCleanup: "background" },
		);
		expect(operations.buildPredictionsJsonl).toHaveBeenCalledWith(
			"project-1",
			"run-1",
		);
	});
});

function createOperations(
	overrides: Partial<BenchmarkRouteOperationsPort> = {},
): BenchmarkRouteOperationsPort {
	return {
		listSuites: vi.fn(async () => []),
		createRun: vi.fn(async () => ({
			status: "ok" as const,
			run: { id: "run-1" },
		})),
		getRun: vi.fn(async () => ({ id: "run-1" })),
		startCoordinator: vi.fn(async () => ({ executionId: "exec-1" })),
		markStatus: vi.fn(async () => ({ id: "run-1" })),
		recomputeSummary: vi.fn(async () => ({ total: 1 })),
		retryTerminalCleanup: vi.fn(async () => ({ id: "run-1" })),
		retryTerminalCleanupByRunId: vi.fn(async () => ({ id: "run-1" })),
		scheduleTerminalCleanupByRunId: vi.fn(async () => ({ id: "run-1" })),
		buildPredictionsJsonl: vi.fn(async () => ""),
		loadTraceBundle: vi.fn(async () => ({})),
		applyPreflight: vi.fn(async () => ({})),
		applyInstanceHostExecutionUpdate: vi.fn(async () => ({})),
		syncInstanceFromExecution: vi.fn(async () => ({})),
		markInstanceInferenceFailure: vi.fn(async () => ({})),
		upsertDatasetArtifact: vi.fn(async () => undefined),
		buildDatasetJsonlByRunId: vi.fn(async () => ""),
		upsertPredictionsArtifact: vi.fn(async () => undefined),
		leaseSnapshot: vi.fn(async () => ({})),
		acquireLeases: vi.fn(async () => ({})),
		releaseLeases: vi.fn(async () => ({})),
		...overrides,
	};
}
