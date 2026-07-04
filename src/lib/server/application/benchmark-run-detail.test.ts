import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationBenchmarkRunDetailPageService,
	type BenchmarkRunDetailReadPort,
} from "$lib/server/application/benchmark-run-detail";
import type { RunStats } from "$lib/server/benchmarks/stats";

describe("ApplicationBenchmarkRunDetailPageService", () => {
	let readModel: BenchmarkRunDetailReadPort;
	let service: ApplicationBenchmarkRunDetailPageService;

	beforeEach(() => {
		readModel = {
			getRun: vi.fn(async () => ({ id: "run-1" }) as never),
			computeRunStats: vi.fn(async () => runStats()),
			getCapacityDiagnostics: vi.fn(async () => ({ ok: true }) as never),
			getPhaseAttribution: vi.fn(async () => ({ phases: [] }) as never),
			getFailureContext: vi.fn(async () => ({ categories: [] }) as never),
			getHeadlampCluster: vi.fn(() => "dev" as const),
		};
		service = new ApplicationBenchmarkRunDetailPageService(readModel);
	});

	it("loads the run detail read model through ports", async () => {
		await expect(
			service.load({ projectId: "project-1", runId: "run-1" }),
		).resolves.toMatchObject({
			status: "ok",
			data: {
				runId: "run-1",
				run: { id: "run-1" },
				runStats: { resolved: 1 },
				capacityDiagnostics: { ok: true },
				headlampCluster: "dev",
			},
		});

		expect(readModel.getRun).toHaveBeenCalledWith("project-1", "run-1");
		expect(readModel.computeRunStats).toHaveBeenCalledWith("run-1");
		expect(readModel.getCapacityDiagnostics).toHaveBeenCalledWith(
			"project-1",
			"run-1",
		);
		expect(readModel.getFailureContext).toHaveBeenCalledWith(
			"project-1",
			"run-1",
		);
	});

	it("uses empty stats and preserves best-effort diagnostics when optional reads fail", async () => {
		vi.mocked(readModel.computeRunStats).mockRejectedValueOnce(
			new Error("clickhouse down"),
		);
		vi.mocked(readModel.getCapacityDiagnostics).mockRejectedValueOnce(
			new Error("capacity down"),
		);
		vi.mocked(readModel.getPhaseAttribution).mockRejectedValueOnce(
			new Error("phase down"),
		);
		vi.mocked(readModel.getFailureContext).mockRejectedValueOnce(
			new Error("failure down"),
		);

		await expect(
			service.load({ projectId: "project-1", runId: "run-1" }),
		).resolves.toMatchObject({
			status: "ok",
			data: {
				runStats: {
					resolved: 0,
					total: 0,
					failureCategoryCounts: { unknown: 0 },
				},
				capacityDiagnostics: null,
				phaseAttribution: null,
				failureContext: null,
			},
		});
	});

	it("returns not found without a project or when the run is missing", async () => {
		await expect(
			service.load({ projectId: null, runId: "run-1" }),
		).resolves.toEqual({ status: "not_found", message: "Run not found" });
		expect(readModel.getRun).not.toHaveBeenCalled();

		vi.mocked(readModel.getRun).mockResolvedValueOnce(null);
		await expect(
			service.load({ projectId: "project-1", runId: "missing" }),
		).resolves.toEqual({ status: "not_found", message: "Run not found" });
	});

	it("serves API detail with optional stats and lite instance payloads", async () => {
		vi.mocked(readModel.getRun).mockResolvedValueOnce({
			id: "run-1",
			instances: [
				{
					id: "instance-1",
					harnessResult: { resolved: true },
					testOutputSummary: "large output",
				},
			],
		} as never);

		await expect(
			service.getApiDetail({
				projectId: "project-1",
				runId: "run-1",
				includeStats: false,
				lite: true,
			}),
		).resolves.toMatchObject({
			status: "ok",
			body: {
				run: {
					instances: [
						{
							harnessResult: null,
							testOutputSummary: null,
						},
					],
				},
				runStats: null,
				capacityDiagnostics: { ok: true },
			},
		});

		expect(readModel.computeRunStats).not.toHaveBeenCalled();
		expect(readModel.getCapacityDiagnostics).toHaveBeenCalledWith(
			"project-1",
			"run-1",
		);
	});
});

function runStats(): RunStats {
	return {
		resolved: 1,
		total: 1,
		resolvedRate: 1,
		byRepo: [],
		byDifficulty: null,
		byStatus: [],
		byTool: [],
		byTerminationReason: [],
		tokensTotal: 0,
		tokensInTotal: 0,
		tokensOutTotal: 0,
		tokensCacheReadTotal: 0,
		tokensCacheCreateTotal: 0,
		cacheHitRate: 0,
		costUsdTotal: 0,
		costPerResolved: 0,
		llmCallCount: 0,
		turnCountP50: null,
		turnCountP90: null,
		ttftP50: null,
		ttftP90: null,
		byScorer: [],
		inferenceDurationMs: {
			count: 0,
			p50: null,
			p90: null,
			max: null,
			mean: null,
		},
		failureCategoryCounts: {
			resolved: 1,
			unresolved: 0,
			empty_patch: 0,
			patch_apply_failed: 0,
			test_timeout: 0,
			test_failed: 0,
			error: 0,
			timeout: 0,
			unknown: 0,
		},
		cumulativeResolved: [],
		cohortRows: [],
		humanAnnotations: {
			counts: { correct: 0, incorrect: 0, partial: 0, unsure: 0 },
			totalAnnotated: 0,
			harnessDisagreement: 0,
		},
	};
}
