import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationBenchmarkCompareService } from "$lib/server/application/benchmark-compare";
import type {
	BenchmarkCompareReadModel,
	BenchmarkRunReadRepository,
} from "$lib/server/application/ports";

describe("ApplicationBenchmarkCompareService", () => {
	let benchmarkRuns: BenchmarkRunReadRepository;
	let service: ApplicationBenchmarkCompareService;

	beforeEach(() => {
		benchmarkRuns = {
			listRuns: vi.fn(),
			loadCompareData: vi.fn(async () => compareReadModel()),
		};
		service = new ApplicationBenchmarkCompareService(benchmarkRuns);
	});

	it("loads compare data through the benchmark run read port", async () => {
		await expect(
			service.getApiCompare({
				projectId: "project-1",
				runsParam: "run-1, run-2, run-1",
			}),
		).resolves.toEqual({
			status: "ok",
			body: compareReadModel(),
		});

		expect(benchmarkRuns.loadCompareData).toHaveBeenCalledWith({
			projectId: "project-1",
			runIds: ["run-1", "run-2"],
		});
	});

	it("validates API-specific route inputs before calling ports", async () => {
		await expect(
			service.getApiCompare({ projectId: null, runsParam: "run-1,run-2" }),
		).resolves.toEqual({
			status: "no_workspace",
			message: "No active workspace",
		});

		await expect(
			service.getApiCompare({ projectId: "project-1", runsParam: "" }),
		).resolves.toEqual({
			status: "bad_request",
			message: "Missing ?runs= parameter",
		});

		await expect(
			service.getApiCompare({ projectId: "project-1", runsParam: "run-1" }),
		).resolves.toEqual({
			status: "bad_request",
			message: "Provide at least 2 runs to compare",
		});

		await expect(
			service.getApiCompare({
				projectId: "project-1",
				runsParam: "run-1,run-2,run-3,run-4,run-5",
			}),
		).resolves.toEqual({
			status: "bad_request",
			message: "Compare supports at most 4 runs",
		});

		expect(benchmarkRuns.loadCompareData).not.toHaveBeenCalled();
	});
});

function compareReadModel(): BenchmarkCompareReadModel {
	return {
		runs: [],
		axisDiff: {} as BenchmarkCompareReadModel["axisDiff"],
		grid: {},
		allInstanceIds: [],
		sharedInstanceIds: [],
		disagreements: [],
		regression: [],
	};
}
