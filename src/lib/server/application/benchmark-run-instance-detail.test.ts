import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationBenchmarkRunInstanceDetailService,
	type BenchmarkRunInstanceDetailMlflowLinks,
} from "$lib/server/application/benchmark-run-instance-detail";
import type {
	BenchmarkRunInstanceDetailReadModel,
	WorkflowDataService,
} from "$lib/server/application/ports";

describe("ApplicationBenchmarkRunInstanceDetailService", () => {
	let workflowData: Pick<WorkflowDataService, "getBenchmarkRunInstanceDetail">;
	let mlflowLinks: BenchmarkRunInstanceDetailMlflowLinks;
	let service: ApplicationBenchmarkRunInstanceDetailService;

	beforeEach(() => {
		workflowData = {
			getBenchmarkRunInstanceDetail: vi.fn(async () => detailReadModel()),
		};
		mlflowLinks = {
			runUrl: vi.fn(() => "https://mlflow.example/#/experiments/exp-1/runs/run-ml"),
			tracesUrl: vi.fn(() => "/api/observability/mlflow/traces/tr-1"),
		};
		service = new ApplicationBenchmarkRunInstanceDetailService({
			workflowData,
			mlflowLinks,
		});
	});

	it("projects benchmark run instance detail through ports", async () => {
		await expect(
			service.getDetail({
				runId: "run-1",
				instanceId: "instance-1",
				projectId: "project-1",
			}),
		).resolves.toMatchObject({
			status: "ok",
			body: {
				runInstance: {
					id: "bri-1",
					hostJobName: "swebench-host-job",
					mlflowUrl: "https://mlflow.example/#/experiments/exp-1/runs/run-ml",
					mlflowTracesUrl: "/api/observability/mlflow/traces/tr-1",
				},
				instance: {
					repo: "example/repo",
					testMetadata: {
						environmentKey: "py311",
					},
				},
				goldPatch: "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n+ok",
				goldPatchStats: {
					addedLines: 1,
					removedLines: 0,
					filesTouched: 1,
				},
				parsedHarness: {
					resolved: true,
					failureCategory: "resolved",
				},
				postHocEvaluationArtifactsAvailable: true,
			},
		});

		expect(workflowData.getBenchmarkRunInstanceDetail).toHaveBeenCalledWith({
			runId: "run-1",
			instanceId: "instance-1",
			projectId: "project-1",
		});
		expect(mlflowLinks.runUrl).toHaveBeenCalledWith({
			experimentId: "exp-1",
			runId: "run-ml",
		});
		expect(mlflowLinks.tracesUrl).toHaveBeenCalledWith({
			experimentId: "exp-1",
			traceId: "tr-1",
		});
	});

	it("withholds post-hoc patches until evaluation artifacts are available", async () => {
		vi.mocked(workflowData.getBenchmarkRunInstanceDetail).mockResolvedValueOnce({
			...detailReadModel(),
			runInstance: {
				...detailReadModel().runInstance,
				evaluationStatus: "running",
				evaluatedAt: null,
			},
		});

		await expect(
			service.getDetail({
				runId: "run-1",
				instanceId: "instance-1",
				projectId: "project-1",
			}),
		).resolves.toMatchObject({
			status: "ok",
			body: {
				goldPatch: null,
				goldPatchStats: {
					addedLines: 0,
					removedLines: 0,
					filesTouched: 0,
				},
				postHocEvaluationArtifactsAvailable: false,
			},
		});
	});

	it("maps missing project or read-model misses to route-friendly statuses", async () => {
		await expect(
			service.getDetail({
				runId: "run-1",
				instanceId: "instance-1",
				projectId: null,
			}),
		).resolves.toEqual({ status: "run_not_found", message: "Run not found" });

		vi.mocked(workflowData.getBenchmarkRunInstanceDetail).mockResolvedValueOnce({
			status: "run_not_found",
		});
		await expect(
			service.getDetail({
				runId: "missing",
				instanceId: "instance-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({ status: "run_not_found", message: "Run not found" });

		vi.mocked(workflowData.getBenchmarkRunInstanceDetail).mockResolvedValueOnce({
			status: "instance_not_found",
		});
		await expect(
			service.getDetail({
				runId: "run-1",
				instanceId: "missing",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "instance_not_found",
			message: "Instance not found in this run",
		});
	});

	it("returns bad_request without invoking ports when ids are missing", async () => {
		await expect(
			service.getDetail({
				runId: "",
				instanceId: " ",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "bad_request",
			message: "runId and instanceId required",
		});

		expect(workflowData.getBenchmarkRunInstanceDetail).not.toHaveBeenCalled();
	});
});

function detailReadModel(): Extract<
	BenchmarkRunInstanceDetailReadModel,
	{ status: "ok" }
> {
	return {
		status: "ok",
		mlflowExperimentId: "exp-1",
		runInstance: {
			id: "bri-1",
			runId: "run-1",
			instanceId: "instance-1",
			evaluationStatus: "resolved",
			evaluatedAt: new Date("2026-07-01T00:00:00Z"),
			harnessResult: { resolved: true },
			mlflowRunId: "run-ml",
			traceIds: ["tr-1"],
		},
		instance: {
			repo: "example/repo",
			baseCommit: "abc123",
			problemStatement: "Fix it",
			hintsText: null,
			testMetadata: {
				environmentKey: "py311",
				goldPatch: "hidden",
			},
			metadata: { difficulty: "easy" },
			goldPatch:
				"diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n+ok",
		},
		executionIr: { dispatch: { jobName: "swebench-host-job" } },
		executionOutput: null,
	};
}
