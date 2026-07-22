import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationBulkLifecycleStopService } from "$lib/server/application/lifecycle-bulk-stop";
import type {
	BenchmarkRunCancellationPort,
	EvaluationRunCancellationPort,
	LifecycleCoordinatorCancelNotifier,
	SessionLifecycleController,
	WorkflowExecutionCoordinatorOwnerPort,
	WorkflowExecutionLifecycleControllerPort,
} from "$lib/server/application/ports";

describe("ApplicationBulkLifecycleStopService", () => {
	let sessionLifecycle: SessionLifecycleController;
	let workflowLifecycle: WorkflowExecutionLifecycleControllerPort;
	let workflowCoordinatorOwners: WorkflowExecutionCoordinatorOwnerPort;
	let benchmarkRuns: BenchmarkRunCancellationPort;
	let evaluationRuns: EvaluationRunCancellationPort;
	let coordinatorCancels: LifecycleCoordinatorCancelNotifier;
	let service: ApplicationBulkLifecycleStopService;

	beforeEach(() => {
		sessionLifecycle = {
      checkSessionAccess: vi.fn(async () => ({
        status: "ok" as const,
        active: true,
      })),
			pauseSession: vi.fn(async () => ({ ok: true as const })),
			resumeSession: vi.fn(async () => ({ ok: true as const })),
			stopSession: vi.fn(async () => ({
				confirmed: true,
				notFound: false,
				state: "confirmed" as const,
			})),
			confirmSessionStop: vi.fn(async () => ({ state: "confirmed" })),
			getCoordinatorOwner: vi.fn(async () => null),
			pauseSessionGoal: vi.fn(async () => {}),
		};
		workflowLifecycle = {
      checkExecutionAccess: vi.fn(async () => ({
        status: "ok" as const,
        active: true,
      })),
			stopExecution: vi.fn(async () => ({
				confirmed: false,
				notFound: false,
				state: "stopping" as const,
			})),
			confirmExecutionStop: vi.fn(async () => ({ state: "stopping" })),
		};
		workflowCoordinatorOwners = {
			getCoordinatorOwner: vi.fn(async () => null),
		};
		benchmarkRuns = {
			cancelBenchmarkRun: vi.fn(async () => ({ id: "bench-1" })),
		};
		evaluationRuns = {
			cancelEvaluationRun: vi.fn(async () => ({ id: "eval-1" })),
		};
		coordinatorCancels = {
			scheduleCoordinatorCancel: vi.fn(),
		};
		service = new ApplicationBulkLifecycleStopService({
			sessionLifecycle,
			workflowLifecycle,
			workflowCoordinatorOwners,
			benchmarkRuns,
			evaluationRuns,
			coordinatorCancels,
		});
	});

	it("rejects requests with no valid targets", async () => {
		await expect(
			service.stopMany({
				userId: "user-1",
				projectId: "project-1",
				body: { targets: [{ kind: "bad", id: "x" }] },
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 400,
			message: "No valid targets provided",
		});
	});

	it("rejects requests over the max target limit", async () => {
		await expect(
			service.stopMany({
				userId: "user-1",
				projectId: "project-1",
				body: {
					targets: Array.from({ length: 201 }, (_, i) => ({
						kind: "session",
						id: `session-${i}`,
					})),
				},
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 400,
			message: "Too many targets (max 200)",
		});
	});

	it("dedupes targets and stops sessions through the lifecycle controller", async () => {
		const result = await service.stopMany({
			userId: "user-1",
			projectId: "project-1",
			body: {
				targets: [
					{ kind: "session", id: " session-1 " },
					{ kind: "session", id: "session-1" },
				],
			},
		});

		expect(result).toMatchObject({
			status: "ok",
			body: {
				mode: "terminate",
				summary: { total: 1, confirmed: 1 },
				results: [{ kind: "session", id: "session-1", state: "confirmed" }],
			},
		});
		expect(sessionLifecycle.checkSessionAccess).toHaveBeenCalledWith({
			sessionId: "session-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(sessionLifecycle.stopSession).toHaveBeenCalledTimes(1);
		expect(sessionLifecycle.stopSession).toHaveBeenCalledWith("session-1", {
			mode: "terminate",
			reason: undefined,
			graceMs: undefined,
		});
	});

  it("reports stop-intent persistence failures as per-target 503 errors", async () => {
    vi.mocked(sessionLifecycle.stopSession).mockResolvedValue({
      confirmed: false,
      notFound: false,
      requested: false,
      state: "stopping",
      retryable: true,
      steps: [],
    });

    const result = await service.stopMany({
      userId: "user-1",
      projectId: "project-1",
      body: { targets: [{ kind: "session", id: "session-1" }] },
    });

    expect(result).toMatchObject({
      status: "ok",
      body: {
        summary: { failed: 1, stopping: 0 },
        results: [
          {
            kind: "session",
            id: "session-1",
            state: "error",
            status: 503,
          },
        ],
      },
    });
  });

	it("pauses session goals before interrupting sessions", async () => {
		await service.stopMany({
			userId: "user-1",
			projectId: "project-1",
			body: {
				mode: "interrupt",
				reason: "user asked",
				graceMs: 50,
				targets: [{ kind: "session", id: "session-1" }],
			},
		});

		expect(sessionLifecycle.pauseSessionGoal).toHaveBeenCalledWith("session-1");
		expect(sessionLifecycle.stopSession).toHaveBeenCalledWith("session-1", {
			mode: "interrupt",
			reason: "user asked",
			graceMs: 50,
		});
	});

	it("hides out-of-scope sessions as not found", async () => {
		vi.mocked(sessionLifecycle.checkSessionAccess).mockResolvedValueOnce({
			status: "not_found",
		});

		const result = await service.stopMany({
			userId: "user-1",
			projectId: "project-1",
			body: { targets: [{ kind: "session", id: "session-1" }] },
		});

		expect(result).toMatchObject({
			status: "ok",
			body: {
				results: [{ state: "notFound", status: 404, ok: false }],
				summary: { notFound: 1 },
			},
		});
		expect(sessionLifecycle.stopSession).not.toHaveBeenCalled();
	});

	it("returns coordinator-owned instead of stopping owned sessions", async () => {
		vi.mocked(sessionLifecycle.getCoordinatorOwner).mockResolvedValueOnce({
			kind: "benchmarkRun",
			runId: "bench-1",
		});

		const result = await service.stopMany({
			userId: "user-1",
			projectId: "project-1",
			body: { targets: [{ kind: "session", id: "session-1" }] },
		});

		expect(result).toMatchObject({
			status: "ok",
			body: {
				results: [
					{
						state: "coordinator_owned",
						status: 409,
						ownedBy: "benchmarkRun",
						runId: "bench-1",
					},
				],
				summary: { coordinatorOwned: 1 },
			},
		});
		expect(sessionLifecycle.stopSession).not.toHaveBeenCalled();
	});

	it("stops workflow executions through workflow lifecycle ports", async () => {
		const result = await service.stopMany({
			userId: "user-1",
			projectId: "project-1",
			body: {
				mode: "purge",
				targets: [{ kind: "workflowExecution", id: "exec-1" }],
			},
		});

		expect(result).toMatchObject({
			status: "ok",
			body: {
        results: [
          { kind: "workflowExecution", state: "stopping", status: 202 },
        ],
				summary: { stopping: 1 },
			},
		});
		expect(workflowLifecycle.checkExecutionAccess).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(workflowLifecycle.stopExecution).toHaveBeenCalledWith("exec-1", {
			mode: "purge",
			reason: undefined,
			graceMs: undefined,
		});
	});

	it("cancels benchmark and evaluation runs through run-level authorities", async () => {
		const result = await service.stopMany({
			userId: "user-1",
			projectId: "project-1",
			body: {
				targets: [
					{ kind: "benchmarkRun", id: "bench-1" },
					{ kind: "evalRun", id: "eval-1" },
				],
			},
		});

		expect(result).toMatchObject({
			status: "ok",
			body: {
				summary: { cancelled: 2 },
				results: [
					{ kind: "benchmarkRun", state: "cancelled" },
					{ kind: "evalRun", state: "cancelled" },
				],
			},
		});
		expect(benchmarkRuns.cancelBenchmarkRun).toHaveBeenCalledWith(
			"project-1",
			"bench-1",
			{ terminalCleanup: "background" },
		);
		expect(evaluationRuns.cancelEvaluationRun).toHaveBeenCalledWith(
			"project-1",
			"eval-1",
		);
		expect(coordinatorCancels.scheduleCoordinatorCancel).toHaveBeenCalledWith(
			"benchmarkRun",
			"bench-1",
		);
		expect(coordinatorCancels.scheduleCoordinatorCancel).toHaveBeenCalledWith(
			"evalRun",
			"eval-1",
		);
	});

	it("captures per-target failures without failing the whole bulk response", async () => {
		vi.mocked(benchmarkRuns.cancelBenchmarkRun).mockRejectedValueOnce(
			new Error("boom"),
		);

		const result = await service.stopMany({
			userId: "user-1",
			projectId: "project-1",
			body: { targets: [{ kind: "benchmarkRun", id: "bench-1" }] },
		});

		expect(result).toMatchObject({
			status: "ok",
			body: {
				results: [{ state: "error", status: 500, error: "boom" }],
				summary: { failed: 1 },
			},
		});
	});
});
