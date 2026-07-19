import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationBenchmarkRunLaunchService,
	ApplicationEvaluationRunLaunchService,
	type BenchmarkRunLaunchPort,
	type EvaluationRunLaunchPort,
} from "$lib/server/application/run-launch";

describe("ApplicationBenchmarkRunLaunchService", () => {
	let runs: BenchmarkRunLaunchPort;
	let service: ApplicationBenchmarkRunLaunchService;

	beforeEach(() => {
		runs = {
			listRuns: vi.fn(async () => [{ id: "bench-1" }]),
			createRun: vi.fn(async () => ({
				status: "ok" as const,
				run: { id: "bench-1" },
			})),
			startCoordinator: vi.fn(async () => ({ executionId: "coord-1" })),
			markStatus: vi.fn(async () => null),
			getRun: vi.fn(async () => ({ id: "bench-1", status: "queued" })),
		};
		service = new ApplicationBenchmarkRunLaunchService(runs);
	});

	it("lists an empty result without a project scope", async () => {
		await expect(
			service.listRuns({ projectId: null, limit: 20, tag: "x" }),
		).resolves.toEqual({ runs: [] });
		expect(runs.listRuns).not.toHaveBeenCalled();
	});

	it("creates a run, starts the coordinator, and marks the run queued", async () => {
		await expect(
			service.startRun({
				projectId: "project-1",
				userId: "user-1",
				body: {
					suiteSlug: "SWE-bench_Verified",
					agentId: "agent-1",
					instanceIds: ["i1"],
					concurrency: "3",
					maxTurns: "25",
					tags: ["campaign"],
					requirePrevalidatedEnvironments: true,
				},
			}),
		).resolves.toEqual({
			status: "ok",
			httpStatus: 201,
			body: {
				run: { id: "bench-1", status: "queued" },
				coordinatorStartError: null,
			},
		});

		expect(runs.createRun).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				userId: "user-1",
				suiteSlug: "SWE-bench_Verified",
				agentId: "agent-1",
				concurrency: 3,
				maxTurns: 25,
				tags: ["campaign"],
				requirePrevalidatedEnvironments: true,
			}),
		);
		expect(runs.markStatus).toHaveBeenCalledWith("bench-1", "queued", {
			coordinatorExecutionId: "coord-1",
		});
	});

	it("fails the created run when coordinator start fails", async () => {
		vi.mocked(runs.startCoordinator).mockRejectedValueOnce(new Error("boom"));

		await expect(
			service.startRun({
				projectId: "project-1",
				userId: "user-1",
				body: { requirePrevalidatedEnvironments: true },
			}),
		).resolves.toMatchObject({
			status: "ok",
			body: { coordinatorStartError: "boom" },
		});
		expect(runs.markStatus).toHaveBeenCalledWith("bench-1", "failed", {
			error: "boom",
		});
	});

	it("keeps launch validation outside the route", async () => {
		await expect(
			service.startRun({
				projectId: "project-1",
				userId: "user-1",
				body: {},
			}),
		).resolves.toMatchObject({
			status: "error",
			httpStatus: 400,
		});

		vi.mocked(runs.createRun).mockResolvedValueOnce({
			status: "validation_error",
			message: "invalid agent",
		});
		await expect(
			service.startRun({
				projectId: "project-1",
				userId: "user-1",
				body: { requirePrevalidatedEnvironments: true },
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 400,
			body: { message: "invalid agent" },
		});
	});

	it("rejects benchmark coordination when deployment policy excludes it", async () => {
		service = new ApplicationBenchmarkRunLaunchService(runs, {
			coordinatedWorkloadAvailability: () => ({
				available: false,
				code: "unsupported_in_preview",
				message: "benchmark coordinators are unavailable in preview deployments",
			}),
		});

		await expect(
			service.startRun({
				projectId: "project-1",
				userId: "user-1",
				body: { requirePrevalidatedEnvironments: true },
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 409,
			body: {
				code: "unsupported_in_preview",
				message: "benchmark coordinators are unavailable in preview deployments",
			},
		});
		expect(runs.createRun).not.toHaveBeenCalled();
	});
});

describe("ApplicationEvaluationRunLaunchService", () => {
	let runs: EvaluationRunLaunchPort;
	let service: ApplicationEvaluationRunLaunchService;

	beforeEach(() => {
		runs = {
			listRuns: vi.fn(async () => [{ id: "eval-1" }]),
			createRun: vi.fn(async () => ({ id: "eval-1", status: "queued" })),
			startCoordinator: vi.fn(async () => ({ executionId: "eval-coord-1" })),
			markStatus: vi.fn(async () => null),
		};
		service = new ApplicationEvaluationRunLaunchService(runs);
	});

	it("defaults unknown subjects to imported outputs and skips coordinator start", async () => {
		await expect(
			service.startRun({
				projectId: "project-1",
				userId: "user-1",
				body: { evaluationId: "eval-def-1", subjectType: "unexpected" },
			}),
		).resolves.toMatchObject({
			status: "ok",
			body: { coordinatorStartError: null },
		});

		expect(runs.createRun).toHaveBeenCalledWith(
			expect.objectContaining({ subjectType: "imported_outputs" }),
		);
		expect(runs.startCoordinator).not.toHaveBeenCalled();
	});

	it("starts coordinator-backed evaluation runs and updates the read model", async () => {
		const result = await service.startRun({
			projectId: "project-1",
			userId: "user-1",
			body: {
				evaluationId: "eval-def-1",
				subjectType: "agent",
				subjectId: "agent-1",
				rowIds: [1, "row-2"],
			},
		});

		expect(result).toEqual({
			status: "ok",
			httpStatus: 201,
			body: {
				run: {
					id: "eval-1",
					status: "running",
					coordinatorExecutionId: "eval-coord-1",
				},
				coordinatorStartError: null,
			},
		});
		expect(runs.markStatus).toHaveBeenCalledWith("eval-1", "running", {
			coordinatorExecutionId: "eval-coord-1",
		});
	});

	it("marks coordinator start failures on the run", async () => {
		vi.mocked(runs.startCoordinator).mockRejectedValueOnce(new Error("down"));

		await expect(
			service.startRun({
				projectId: "project-1",
				userId: "user-1",
				body: { subjectType: "workflow" },
			}),
		).resolves.toMatchObject({
			status: "ok",
			body: {
				run: { status: "failed", error: "down" },
				coordinatorStartError: "down",
			},
		});
		expect(runs.markStatus).toHaveBeenCalledWith("eval-1", "failed", {
			error: "down",
		});
	});

	it("rejects coordinator-backed evaluations while preserving imported-output runs", async () => {
		service = new ApplicationEvaluationRunLaunchService(runs, {
			coordinatedWorkloadAvailability: () => ({
				available: false,
				code: "unsupported_in_preview",
				message: "evaluation coordinators are unavailable in preview deployments",
			}),
		});

		await expect(
			service.startRun({
				projectId: "project-1",
				userId: "user-1",
				body: { subjectType: "agent" },
			}),
		).resolves.toMatchObject({
			status: "error",
			httpStatus: 409,
			body: { code: "unsupported_in_preview" },
		});
		expect(runs.createRun).not.toHaveBeenCalled();

		await expect(
			service.startRun({
				projectId: "project-1",
				userId: "user-1",
				body: { subjectType: "imported_outputs" },
			}),
		).resolves.toMatchObject({ status: "ok" });
		expect(runs.createRun).toHaveBeenCalledTimes(1);
	});
});
