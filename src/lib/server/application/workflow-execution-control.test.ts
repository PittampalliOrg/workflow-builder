import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowExecutionControlService } from "$lib/server/application/workflow-execution-control";
import type {
	WorkflowApprovalEventPort,
	WorkflowDataService,
	WorkflowDefinition,
	WorkflowExecutionCoordinatorOwnerPort,
	WorkflowExecutionLifecycleControllerPort,
	WorkflowExecutionRecord,
	WorkflowExecutionReadModelPort,
	WorkflowRunStarterPort,
	WorkflowSpecValidatorPort,
} from "$lib/server/application/ports";

describe("ApplicationWorkflowExecutionControlService", () => {
	let workflowData: Pick<
		WorkflowDataService,
		| "getExecutionById"
		| "getScopedExecutionById"
		| "getWorkflowByRef"
		| "getRunningWorkflowExecution"
		| "isPlatformAdmin"
		| "validateApiKeyForUser"
	>;
	let approvalEvents: WorkflowApprovalEventPort;
	let coordinatorOwners: WorkflowExecutionCoordinatorOwnerPort;
	let executionLifecycle: WorkflowExecutionLifecycleControllerPort;
	let executionReadModels: WorkflowExecutionReadModelPort;
	let runStarter: WorkflowRunStarterPort;
	let workflowSpecs: WorkflowSpecValidatorPort;
	let service: ApplicationWorkflowExecutionControlService;

	beforeEach(() => {
		workflowData = {
			getExecutionById: vi.fn(async () => executionRecord()),
			getScopedExecutionById: vi.fn(async () => executionRecord()),
			getWorkflowByRef: vi.fn(async () => workflowDefinition()),
			getRunningWorkflowExecution: vi.fn(async () => null),
			isPlatformAdmin: vi.fn(async () => true),
			validateApiKeyForUser: vi.fn(async () => ({
				valid: true as const,
				apiKeyId: "key-1",
			})),
		};
		approvalEvents = {
			raiseApprovalEvent: vi.fn(async () => ({ ok: true as const })),
			raiseWorkflowEvent: vi.fn(async () => ({ ok: true as const })),
		};
		coordinatorOwners = {
			getCoordinatorOwner: vi.fn(async () => null),
		};
		executionLifecycle = {
			checkExecutionAccess: vi.fn(async () => ({
				status: "ok" as const,
				active: true,
			})),
			stopExecution: vi.fn(async () => ({
				confirmed: true,
				notFound: false,
				state: "confirmed",
				requested: true,
				steps: [],
			})),
			confirmExecutionStop: vi.fn(async () => ({
				state: "confirmed",
			})),
		};
		executionReadModels = {
			loadExecutionReadModel: vi.fn(async () => ({
				id: "exec-1",
				status: "running",
				phase: "running",
			})),
			serializeExecutionReadModel: vi.fn((model) => ({
				...(model as Record<string, unknown>),
				serialized: true,
			})),
		};
		runStarter = {
			startWorkflowRun: vi.fn(async () => ({
				ok: true as const,
				executionId: "exec-new",
				instanceId: "instance-new",
			})),
		};
		workflowSpecs = {
			isServerlessWorkflow: vi.fn(() => true),
		};
		service = new ApplicationWorkflowExecutionControlService({
			workflowData,
			approvalEvents,
			coordinatorOwners,
			executionLifecycle,
			executionReadModels,
			runStarter,
			workflowSpecs,
		});
	});

	it("does not trust launch provenance supplied in generic request JSON", async () => {
		const result = await service.executeWorkflow({
			workflowId: "workflow-1",
			userId: "user-1",
			projectId: "project-1",
			body: {
				input: { prompt: "ship it" },
				launchSurface: "dev-environment",
			},
		});

		expect(workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "workflow-1",
			lookup: "id",
		});
		expect(runStarter.startWorkflowRun).toHaveBeenCalledWith({
			workflowId: "workflow-1",
			triggerData: { prompt: "ship it" },
			userId: "user-1",
		});
		expect(workflowData.isPlatformAdmin).not.toHaveBeenCalled();
		expect(result).toEqual({
			status: "ok",
			body: {
				executionId: "exec-new",
				instanceId: "instance-new",
				workflowId: "workflow-1",
				status: "running",
			},
		});
	});

	it("forwards trusted Dev launch provenance for a platform admin", async () => {
		const result = await service.executeDevWorkflow({
			workflowId: "workflow-1",
			userId: "admin-1",
			projectId: "project-1",
			requestOrigin: "https://wfb-feature-one.tail286401.ts.net",
			body: { input: { mode: "host-throwaway" } },
		});

		expect(workflowData.isPlatformAdmin).toHaveBeenCalledWith("admin-1");
		expect(runStarter.startWorkflowRun).toHaveBeenCalledWith({
			workflowId: "workflow-1",
			triggerData: { mode: "host-throwaway" },
			userId: "admin-1",
			launchSurface: "dev-environment",
			launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
		});
		expect(result.status).toBe("ok");
	});

	it("rejects trusted Dev launch provenance for a non-admin", async () => {
		vi.mocked(workflowData.isPlatformAdmin).mockResolvedValueOnce(false);

		const result = await service.executeDevWorkflow({
			workflowId: "workflow-1",
			userId: "user-1",
			projectId: "project-1",
			requestOrigin: "https://wfb-feature-one.tail286401.ts.net",
			body: { input: { mode: "host-throwaway" } },
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 403,
			message: "Admin access required",
		});
		expect(runStarter.startWorkflowRun).not.toHaveBeenCalled();
	});

	it("hides out-of-workspace workflows before starting authenticated execution", async () => {
		vi.mocked(workflowData.getWorkflowByRef).mockResolvedValue(
			workflowDefinition({ projectId: "project-2" }),
		);

		const result = await service.executeWorkflow({
			workflowId: "workflow-1",
			userId: "user-1",
			projectId: "project-1",
			body: { input: { prompt: "ship it" } },
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 404,
			message: "Workflow not found",
		});
		expect(runStarter.startWorkflowRun).not.toHaveBeenCalled();
	});

	it("starts a public webhook workflow after API key, trigger, spec, and duplicate checks", async () => {
		const result = await service.startWebhookExecution({
			workflowId: "workflow-1",
			authorizationHeader: "Bearer wfb_secret",
			body: { message: "hello" },
		});

		expect(workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "workflow-1",
			lookup: "id",
		});
		expect(workflowData.validateApiKeyForUser).toHaveBeenCalledWith({
			authorizationHeader: "Bearer wfb_secret",
			userId: "user-1",
      projectId: "project-1",
		});
		expect(workflowSpecs.isServerlessWorkflow).toHaveBeenCalledWith(
			workflowDefinition().spec,
		);
		expect(workflowData.getRunningWorkflowExecution).toHaveBeenCalledWith(
			"workflow-1",
		);
		expect(runStarter.startWorkflowRun).toHaveBeenCalledWith({
			workflowId: "workflow-1",
			triggerData: { message: "hello" },
			userId: "user-1",
			triggerSource: "webhook",
		});
		expect(result).toEqual({
			status: "ok",
			body: {
				executionId: "exec-new",
				status: "running",
			},
		});
	});

	it("rejects invalid webhook API keys before duplicate checks", async () => {
		vi.mocked(workflowData.validateApiKeyForUser).mockResolvedValue({
			valid: false,
			error: "Invalid API key",
			statusCode: 401,
		});

		const result = await service.startWebhookExecution({
			workflowId: "workflow-1",
			authorizationHeader: "Bearer bad",
			body: { message: "hello" },
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 401,
			message: "Invalid API key",
		});
		expect(workflowData.getRunningWorkflowExecution).not.toHaveBeenCalled();
		expect(runStarter.startWorkflowRun).not.toHaveBeenCalled();
	});

	it("preserves webhook duplicate-run conflict responses", async () => {
		vi.mocked(workflowData.getRunningWorkflowExecution).mockResolvedValue({
			id: "exec-running",
			status: "running",
		});

		const result = await service.startWebhookExecution({
			workflowId: "workflow-1",
			authorizationHeader: "Bearer wfb_secret",
			body: { message: "hello" },
		});

		expect(result).toEqual({
			status: "ok",
			httpStatus: 409,
			body: {
				error: "A workflow execution is already running",
				existingExecutionId: "exec-running",
			},
		});
		expect(runStarter.startWorkflowRun).not.toHaveBeenCalled();
	});

	it("requests workflow execution stops through the lifecycle port", async () => {
		const result = await service.stopExecution({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			body: { mode: "purge", reason: "user requested", graceMs: 250 },
		});

		expect(executionLifecycle.checkExecutionAccess).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(executionLifecycle.stopExecution).toHaveBeenCalledWith("exec-1", {
			mode: "purge",
			reason: "user requested",
			graceMs: 250,
		});
		expect(result).toEqual({
			status: "ok",
			httpStatus: 200,
			body: {
				ok: true,
				confirmed: true,
				notFound: false,
				state: "confirmed",
				requested: true,
				steps: [],
			},
		});
	});

	it("defaults invalid workflow stop modes to terminate", async () => {
		await service.stopExecution({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			body: { mode: "destroy" },
		});

		expect(executionLifecycle.stopExecution).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({ mode: "terminate" }),
		);
	});

	it("maps converging workflow stops to accepted responses", async () => {
		vi.mocked(executionLifecycle.stopExecution).mockResolvedValue({
			confirmed: false,
			notFound: false,
			state: "stopping",
			requested: true,
			steps: [],
		});

		const result = await service.stopExecution(commandInput());

		expect(result).toMatchObject({
			status: "ok",
			httpStatus: 202,
			body: { ok: false, state: "stopping" },
		});
	});

  it("maps workflow stop-intent persistence failures to 503", async () => {
    vi.mocked(executionLifecycle.stopExecution).mockResolvedValue({
      confirmed: false,
      notFound: false,
      state: "stopping",
      requested: false,
      retryable: true,
      steps: [],
    });

    await expect(service.stopExecution(commandInput())).resolves.toEqual({
      status: "error",
      httpStatus: 503,
      message: "Stop intent could not be persisted - please retry.",
    });
  });

	it("blocks coordinator-owned workflow execution stops", async () => {
		vi.mocked(coordinatorOwners.getCoordinatorOwner).mockResolvedValue({
			kind: "evalRun",
			runId: "eval-1",
		});

		const result = await service.stopExecution(commandInput());

		expect(result).toEqual({
			status: "ok",
			httpStatus: 409,
			body: {
				ok: false,
				error: "coordinator_owned",
				ownedBy: "evalRun",
				runId: "eval-1",
				message:
					"This is an evaluation instance — cancel the evaluation run instead.",
			},
		});
		expect(executionLifecycle.stopExecution).not.toHaveBeenCalled();
	});

	it("hides workflow stops outside the active workspace", async () => {
		vi.mocked(executionLifecycle.checkExecutionAccess).mockResolvedValue({
			status: "not_found",
		});

		const result = await service.stopExecution(commandInput());

		expect(result).toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
		expect(executionLifecycle.stopExecution).not.toHaveBeenCalled();
	});

	it("confirms workflow stop status through the lifecycle port", async () => {
		const result = await service.getStopStatus({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});

		expect(executionLifecycle.confirmExecutionStop).toHaveBeenCalledWith(
			"exec-1",
		);
		expect(result).toEqual({
			status: "ok",
			body: { state: "confirmed" },
		});
	});

	it("returns execution detail with coordinator ownership", async () => {
		vi.mocked(coordinatorOwners.getCoordinatorOwner).mockResolvedValue({
			kind: "benchmarkRun",
			runId: "bench-1",
		});

		const result = await service.getExecutionDetail({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});

		expect(workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(coordinatorOwners.getCoordinatorOwner).toHaveBeenCalledWith(
			"exec-1",
		);
		expect(result).toMatchObject({
			status: "ok",
			body: {
				id: "exec-1",
				workflowId: "workflow-1",
				owner: { kind: "benchmarkRun", runId: "bench-1" },
			},
		});
	});

	it("hides execution detail outside the active workspace", async () => {
		vi.mocked(workflowData.getExecutionById).mockResolvedValue(
			executionRecord({ projectId: "project-2" }),
		);

		const result = await service.getExecutionDetail({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
		expect(coordinatorOwners.getCoordinatorOwner).not.toHaveBeenCalled();
	});

	it("preserves unauthenticated execution detail behavior", async () => {
		const result = await service.getExecutionDetail({
			executionId: "exec-1",
			userId: null,
			projectId: null,
		});

		expect(result).toMatchObject({
			status: "ok",
			body: { id: "exec-1" },
		});
	});

	it("loads execution status through the read-model port after scoped precheck", async () => {
		const result = await service.getExecutionStatus({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			includeAgentEvents: true,
		});

		expect(workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(executionReadModels.loadExecutionReadModel).toHaveBeenCalledWith({
			executionId: "exec-1",
			refreshRuntime: true,
			includeAgentEvents: true,
		});
		expect(
			executionReadModels.serializeExecutionReadModel,
		).toHaveBeenCalledWith(expect.objectContaining({ id: "exec-1" }), {
			compact: false,
			includeAgentEvents: true,
		});
		expect(result).toEqual({
			status: "ok",
			body: {
				id: "exec-1",
				status: "running",
				phase: "running",
				serialized: true,
			},
		});
	});

	it("hides execution status outside the active workspace before loading the model", async () => {
		vi.mocked(workflowData.getExecutionById).mockResolvedValue(
			executionRecord({ projectId: "project-2" }),
		);

		const result = await service.getExecutionStatus({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			includeAgentEvents: false,
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
		expect(executionReadModels.loadExecutionReadModel).not.toHaveBeenCalled();
	});

	it("maps read-model migration failures to route-safe unavailable errors", async () => {
		vi.mocked(executionReadModels.loadExecutionReadModel).mockRejectedValue(
			new Error("Execution read-model migration is required"),
		);

		const result = await service.getExecutionStatus({
			executionId: "exec-1",
			userId: null,
			projectId: null,
			includeAgentEvents: false,
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 503,
			message: "Execution read-model migration is required",
		});
	});

	it("raises the default approval event for scoped executions", async () => {
		const result = await service.approveExecution({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			body: {},
		});

		expect(workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(approvalEvents.raiseApprovalEvent).toHaveBeenCalledWith({
			instanceId: "instance-1",
			eventType: "goal_spec_approval",
			approvedBy: "user-1",
		});
		expect(result).toEqual({
			status: "ok",
			body: {
				ok: true,
				eventType: "goal_spec_approval",
				instanceId: "instance-1",
			},
		});
	});

	it("trims custom event names before raising the event", async () => {
		await service.approveExecution({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			body: { eventType: " custom.approval " },
		});

		expect(approvalEvents.raiseApprovalEvent).toHaveBeenCalledWith(
			expect.objectContaining({ eventType: "custom.approval" }),
		);
	});

	it("hides executions outside the active project", async () => {
		vi.mocked(workflowData.getExecutionById).mockResolvedValue(
			executionRecord({ projectId: "project-2" }),
		);

		const result = await service.approveExecution(commandInput());

		expect(result).toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
		expect(approvalEvents.raiseApprovalEvent).not.toHaveBeenCalled();
	});

	it("allows legacy projectless executions only for the owning user", async () => {
		vi.mocked(workflowData.getExecutionById).mockResolvedValue(
			executionRecord({ projectId: null, userId: "user-2" }),
		);

		const result = await service.approveExecution(commandInput());

		expect(result).toMatchObject({
			status: "error",
			httpStatus: 404,
		});
	});

	it("returns conflict when no Dapr instance is available for approval", async () => {
		vi.mocked(workflowData.getExecutionById).mockResolvedValue(
			executionRecord({ daprInstanceId: null }),
		);

		const result = await service.approveExecution(commandInput());

		expect(result).toEqual({
			status: "error",
			httpStatus: 409,
			message: "Run has no Dapr instance to signal",
		});
		expect(approvalEvents.raiseApprovalEvent).not.toHaveBeenCalled();
	});

	it("maps missing orchestrator instances to route-safe conflicts", async () => {
		vi.mocked(approvalEvents.raiseApprovalEvent).mockResolvedValue({
			ok: false,
			status: 404,
			detail: "missing",
		});

		const result = await service.approveExecution(commandInput());

		expect(result).toEqual({
			status: "error",
			httpStatus: 409,
			message: "Failed to raise approval event",
		});
	});

	it("maps orchestrator failures to unavailable gateway errors", async () => {
		vi.mocked(approvalEvents.raiseApprovalEvent).mockResolvedValue({
			ok: false,
			status: 500,
			detail: "boom",
		});

		const result = await service.approveExecution(commandInput());

		expect(result).toEqual({
			status: "error",
			httpStatus: 502,
			message: "Failed to raise approval event",
		});
	});

	it("reports approval-state for an active execution parked at a listen gate", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValue(
			executionRecord({ currentNodeId: "goal_spec_approval" }),
		);
		vi.mocked(workflowData.getWorkflowByRef).mockResolvedValue(
			workflowDefinition({
				spec: {
					do: [
						{
							goal_spec_approval: {
								listen: {
									to: { one: { with: { type: "goal_spec_approval" } } },
								},
							},
						},
					],
				},
			}),
		);

		const result = await service.getApprovalState({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});

		expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "workflow-1",
			lookup: "id",
		});
		expect(result).toEqual({
			status: "ok",
			body: {
				awaiting: true,
				nodeId: "goal_spec_approval",
				eventType: "goal_spec_approval",
			},
		});
	});

	it("does not load workflow specs for terminal approval-state requests", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValue(
			executionRecord({
				status: "success",
				currentNodeId: "goal_spec_approval",
			}),
		);

		const result = await service.getApprovalState(commandInput());

		expect(result).toEqual({ status: "ok", body: { awaiting: false } });
		expect(workflowData.getWorkflowByRef).not.toHaveBeenCalled();
	});

	it("hides out-of-scope approval-state requests before loading workflow specs", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValue(null);

		const result = await service.getApprovalState(commandInput());

		expect(result).toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
		expect(workflowData.getWorkflowByRef).not.toHaveBeenCalled();
	});

	it("uses the listen node id as the approval event type fallback", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValue(
			executionRecord({ currentNodeId: "manual_review" }),
		);
		vi.mocked(workflowData.getWorkflowByRef).mockResolvedValue(
			workflowDefinition({
				spec: { do: [{ manual_review: { listen: { to: { one: {} } } } }] },
			}),
		);

		const result = await service.getApprovalState(commandInput());

		expect(result).toEqual({
			status: "ok",
			body: {
				awaiting: true,
				nodeId: "manual_review",
				eventType: "manual_review",
			},
		});
	});

	it("returns non-awaiting approval-state for missing workflow specs or non-listen nodes", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValue(
			executionRecord({ currentNodeId: "plan" }),
		);
		vi.mocked(workflowData.getWorkflowByRef).mockResolvedValue(
			workflowDefinition({ spec: { do: [{ plan: { call: "agent.run" } }] } }),
		);

		await expect(service.getApprovalState(commandInput())).resolves.toEqual({
			status: "ok",
			body: { awaiting: false },
		});

		vi.mocked(workflowData.getWorkflowByRef).mockResolvedValueOnce(null);
		await expect(service.getApprovalState(commandInput())).resolves.toEqual({
			status: "ok",
			body: { awaiting: false },
		});
	});

	it("starts a resumed run from a normalized canvas node and seeds the root workspace", async () => {
		vi.mocked(workflowData.getExecutionById).mockImplementation(async (id) => {
			if (id === "exec-root") {
				return executionRecord({
					id: "exec-root",
					daprInstanceId: "instance-root",
					rerunOfExecutionId: null,
				});
			}
			return executionRecord({
				id: "exec-child",
				input: { repoUrl: "owner/repo" },
				daprInstanceId: "instance-child",
				currentNodeId: "repair",
				rerunOfExecutionId: "exec-root",
			});
		});
		vi.mocked(workflowData.getWorkflowByRef).mockResolvedValue(
			workflowDefinition({
				spec: {
					do: [
						{ plan: { call: "agent.run" } },
						{ repair: { call: "agent.run" } },
					],
				},
			}),
		);

		const result = await service.resumeExecution({
			executionId: "exec-child",
			userId: "user-1",
			projectId: "project-1",
			body: { fromNodeId: "/do/1/repair" },
		});

		expect(workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "workflow-1",
			lookup: "id",
		});
		expect(runStarter.startWorkflowRun).toHaveBeenCalledWith({
			workflowId: "workflow-1",
			triggerData: { repoUrl: "owner/repo" },
			resumeFromNode: "repair",
			seedWorkspaceFrom: "instance-root",
			rerunOfExecutionId: "exec-child",
			rerunSourceInstanceId: "instance-child",
			triggerSource: "resume",
		});
		expect(result).toEqual({
			status: "ok",
			body: {
				ok: true,
				executionId: "exec-new",
				sourceExecutionId: "exec-child",
				newInstanceId: "instance-new",
				fromNodeId: "repair",
				seedWorkspaceFrom: "instance-root",
				seededFromSnapshot: false,
			},
		});
	});

	const THREE_NODE_SPEC = {
		do: [
			{ plan: { call: "agent.run" } },
			{ build: { call: "agent.run" } },
			{ repair: { call: "agent.run" } },
		],
	};

	it("seeds the fork from the immediate predecessor's snapshot (fork re-executes the node)", async () => {
		const workspaceSnapshots = { listSnapshots: vi.fn(async () => ["plan", "build"]) };
		const withSnapshots = new ApplicationWorkflowExecutionControlService({
			workflowData,
			approvalEvents,
			coordinatorOwners,
			executionLifecycle,
			executionReadModels,
			runStarter,
			workflowSpecs,
			workspaceSnapshots,
		});
		vi.mocked(workflowData.getExecutionById).mockResolvedValue(
			executionRecord({
				id: "exec-src",
				daprInstanceId: "instance-src",
				currentNodeId: "repair",
				input: { repoUrl: "owner/repo" },
			}),
		);
		vi.mocked(workflowData.getWorkflowByRef).mockResolvedValue(
			workflowDefinition({ spec: THREE_NODE_SPEC }),
		);

		const result = await withSnapshots.resumeExecution({
			executionId: "exec-src",
			userId: "user-1",
			projectId: "project-1",
			body: { fromNodeId: "repair" },
		});

		// Looked up under the source run's OWN workspace key; seeds "build" (the node
		// BEFORE "repair"), NOT "repair" — fork-from-repair re-runs repair.
		expect(workspaceSnapshots.listSnapshots).toHaveBeenCalledWith("instance-src");
		expect(runStarter.startWorkflowRun).toHaveBeenCalledWith(
			expect.objectContaining({
				resumeFromNode: "repair",
				seedWorkspaceFrom: ".snapshots/instance-src/build",
			}),
		);
		expect(result).toMatchObject({
			status: "ok",
			body: { seededFromSnapshot: true, seedWorkspaceFrom: ".snapshots/instance-src/build" },
		});
	});

	it("walks back past a missing predecessor snapshot (resume-after-failure: fork node never completed)", async () => {
		// The failed node "repair" has no snapshot (it never completed) and "build" has
		// none either; the walk skips both and seeds from "plan".
		const workspaceSnapshots = { listSnapshots: vi.fn(async () => ["plan"]) };
		const withSnapshots = new ApplicationWorkflowExecutionControlService({
			workflowData,
			approvalEvents,
			coordinatorOwners,
			executionLifecycle,
			executionReadModels,
			runStarter,
			workflowSpecs,
			workspaceSnapshots,
		});
		vi.mocked(workflowData.getExecutionById).mockResolvedValue(
			executionRecord({
				id: "exec-src",
				daprInstanceId: "instance-src",
				currentNodeId: "repair",
			}),
		);
		vi.mocked(workflowData.getWorkflowByRef).mockResolvedValue(
			workflowDefinition({ spec: THREE_NODE_SPEC }),
		);

		const result = await withSnapshots.resumeExecution({
			executionId: "exec-src",
			userId: "user-1",
			projectId: "project-1",
			body: { fromNodeId: "repair" },
		});

		expect(runStarter.startWorkflowRun).toHaveBeenCalledWith(
			expect.objectContaining({ seedWorkspaceFrom: ".snapshots/instance-src/plan" }),
		);
		expect(result).toMatchObject({
			status: "ok",
			body: { seededFromSnapshot: true, seedWorkspaceFrom: ".snapshots/instance-src/plan" },
		});
	});

	it("falls back to end-state seeding when no predecessor of the fork node has a snapshot", async () => {
		// Forking from the FIRST node has no predecessor to seed from.
		const workspaceSnapshots = { listSnapshots: vi.fn(async () => ["build"]) };
		const withSnapshots = new ApplicationWorkflowExecutionControlService({
			workflowData,
			approvalEvents,
			coordinatorOwners,
			executionLifecycle,
			executionReadModels,
			runStarter,
			workflowSpecs,
			workspaceSnapshots,
		});
		vi.mocked(workflowData.getExecutionById).mockResolvedValue(
			executionRecord({
				id: "exec-src",
				daprInstanceId: "instance-src",
				currentNodeId: "plan",
				rerunOfExecutionId: null,
			}),
		);
		vi.mocked(workflowData.getWorkflowByRef).mockResolvedValue(
			workflowDefinition({ spec: THREE_NODE_SPEC }),
		);

		const result = await withSnapshots.resumeExecution({
			executionId: "exec-src",
			userId: "user-1",
			projectId: "project-1",
			body: { fromNodeId: "plan" },
		});

		expect(runStarter.startWorkflowRun).toHaveBeenCalledWith(
			expect.objectContaining({ seedWorkspaceFrom: "instance-src" }),
		);
		expect(result).toMatchObject({
			status: "ok",
			body: { seededFromSnapshot: false, seedWorkspaceFrom: "instance-src" },
		});
	});

	it("auto-resumes from the source current node when no node is supplied", async () => {
		vi.mocked(workflowData.getExecutionById).mockResolvedValue(
			executionRecord({
				currentNodeId: "repair",
				input: { prompt: "fix it" },
			}),
		);
		vi.mocked(workflowData.getWorkflowByRef).mockResolvedValue(
			workflowDefinition({
				spec: {
					do: [{ plan: { call: "agent.run" } }, { repair: {} }],
				},
			}),
		);

		const result = await service.resumeExecution(commandInput({ body: {} }));

		expect(runStarter.startWorkflowRun).toHaveBeenCalledWith(
			expect.objectContaining({
				resumeFromNode: "repair",
				triggerData: { prompt: "fix it" },
			}),
		);
		expect(result).toMatchObject({
			status: "ok",
			body: { fromNodeId: "repair" },
		});
	});

	it.each(["running", "pending"] as const)(
		"rejects dynamic-script resume while a %s source only has stop intent",
		async (status) => {
			vi.mocked(workflowData.getExecutionById).mockResolvedValue(
				executionRecord({
					status,
					stopRequestedAt: new Date("2026-07-21T12:00:00.000Z"),
				}),
			);
			vi.mocked(workflowData.getWorkflowByRef).mockResolvedValue(
				workflowDefinition({ engineType: "dynamic-script" }),
			);

			const result = await service.resumeExecution(commandInput({ body: {} }));

			expect(result).toEqual({
				status: "error",
				httpStatus: 409,
				message:
					"Source run is still active; stop it before resuming a dynamic-script run",
			});
			expect(runStarter.startWorkflowRun).not.toHaveBeenCalled();
		},
	);

	it("resumes a dynamic script after the source is confirmed cancelled", async () => {
		vi.mocked(workflowData.getExecutionById).mockResolvedValue(
			executionRecord({
				status: "cancelled",
				input: { prompt: "repair it" },
				completedAt: new Date("2026-07-21T12:01:00.000Z"),
				stopRequestedAt: null,
			}),
		);
		vi.mocked(workflowData.getWorkflowByRef).mockResolvedValue(
			workflowDefinition({ engineType: "dynamic-script" }),
		);

		const result = await service.resumeExecution(commandInput({ body: {} }));

		expect(runStarter.startWorkflowRun).toHaveBeenCalledWith({
			workflowId: "workflow-1",
			triggerData: { prompt: "repair it" },
			journalImportFromExecutionId: "exec-1",
			rerunOfExecutionId: "exec-1",
			rerunSourceInstanceId: "instance-1",
			triggerSource: "resume",
		});
		expect(result).toMatchObject({
			status: "ok",
			body: {
				executionId: "exec-new",
				sourceExecutionId: "exec-1",
				journalImportFromExecutionId: "exec-1",
			},
		});
	});

	function dynamicScriptService(
		scriptCalls: { listInternal: ReturnType<typeof vi.fn> },
		workspaceSnapshots: { listSnapshots: ReturnType<typeof vi.fn> },
	) {
		vi.mocked(workflowData.getExecutionById).mockResolvedValue(
			executionRecord({
				id: "exec-1",
				status: "cancelled",
				stopRequestedAt: null,
				completedAt: new Date("2026-07-21T12:01:00.000Z"),
			}),
		);
		vi.mocked(workflowData.getWorkflowByRef).mockResolvedValue(
			workflowDefinition({ engineType: "dynamic-script" }),
		);
		return new ApplicationWorkflowExecutionControlService({
			workflowData,
			approvalEvents,
			coordinatorOwners,
			executionLifecycle,
			executionReadModels,
			runStarter,
			workflowSpecs,
			scriptCalls: scriptCalls as never,
			workspaceSnapshots,
		});
	}

	it("seeds a dynamic-script resume from the last done call's snapshot", async () => {
		const scriptCalls = {
			listInternal: vi.fn(async () => [
				{ callId: "c0", status: "done" },
				{ callId: "c1", status: "done" },
				{ callId: "c2", status: "error" }, // failed call — not the reused boundary
			]),
		};
		const workspaceSnapshots = { listSnapshots: vi.fn(async () => ["c0", "c1"]) };
		const svc = dynamicScriptService(scriptCalls, workspaceSnapshots);

		const result = await svc.resumeExecution(commandInput({ body: {} }));

		// Snapshots looked up under the run's shared script workspace key.
		expect(workspaceSnapshots.listSnapshots).toHaveBeenCalledWith("ws_script_exec-1");
		expect(runStarter.startWorkflowRun).toHaveBeenCalledWith(
			expect.objectContaining({
				journalImportFromExecutionId: "exec-1",
				seedWorkspaceFrom: ".snapshots/ws_script_exec-1/c1",
			}),
		);
		expect(result).toMatchObject({
			status: "ok",
			body: {
				seededFromSnapshot: true,
				seedWorkspaceFrom: ".snapshots/ws_script_exec-1/c1",
			},
		});
	});

	it("falls back to no workspace seed when the last done call has no snapshot", async () => {
		const scriptCalls = {
			listInternal: vi.fn(async () => [
				{ callId: "c0", status: "done" },
				{ callId: "c1", status: "done" },
			]),
		};
		// c1 (the last done call) never got a snapshot (fire-and-forget miss/race).
		const workspaceSnapshots = { listSnapshots: vi.fn(async () => ["c0"]) };
		const svc = dynamicScriptService(scriptCalls, workspaceSnapshots);

		const result = await svc.resumeExecution(commandInput({ body: {} }));

		const call = vi.mocked(runStarter.startWorkflowRun).mock.calls[0][0];
		expect(call.seedWorkspaceFrom).toBeUndefined();
		expect(call.journalImportFromExecutionId).toBe("exec-1");
		expect(result).toMatchObject({
			status: "ok",
			body: { seededFromSnapshot: false },
		});
	});

	it("returns coordinator-owned resume responses without starting a new run", async () => {
		vi.mocked(coordinatorOwners.getCoordinatorOwner).mockResolvedValue({
			kind: "benchmarkRun",
			runId: "bench-1",
		});

		const result = await service.resumeExecution(commandInput());

		expect(result).toEqual({
			status: "ok",
			httpStatus: 409,
			body: {
				ok: false,
				error: "coordinator_owned",
				ownedBy: "benchmarkRun",
				runId: "bench-1",
				message:
					"This is a benchmark/eval instance — resume via the owning run instead.",
			},
		});
		expect(workflowData.getWorkflowByRef).not.toHaveBeenCalled();
		expect(runStarter.startWorkflowRun).not.toHaveBeenCalled();
	});

	it("returns conflict when no Dapr instance is available for resume", async () => {
		vi.mocked(workflowData.getExecutionById).mockResolvedValue(
			executionRecord({ daprInstanceId: null }),
		);

		const result = await service.resumeExecution(commandInput());

		expect(result).toEqual({
			status: "error",
			httpStatus: 409,
			message: "Run has no Dapr instance id to resume from",
		});
		expect(runStarter.startWorkflowRun).not.toHaveBeenCalled();
	});

	it("rejects resume nodes that are not top-level current workflow nodes", async () => {
		vi.mocked(workflowData.getWorkflowByRef).mockResolvedValue(
			workflowDefinition({ spec: { do: [{ plan: {} }] } }),
		);

		const result = await service.resumeExecution(
			commandInput({ body: { fromNodeId: "repair" } }),
		);

		expect(result).toEqual({
			status: "error",
			httpStatus: 404,
			message: "Node 'repair' is not a top-level node in the current workflow",
		});
		expect(runStarter.startWorkflowRun).not.toHaveBeenCalled();
	});
});

function commandInput(overrides: Record<string, unknown> = {}) {
	return {
		executionId: "exec-1",
		userId: "user-1",
		projectId: "project-1",
		body: { eventType: "goal_spec_approval" },
		...overrides,
	};
}

function workflowDefinition(
	overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
	return {
		id: "workflow-1",
		name: "Workflow 1",
		description: null,
		userId: "user-1",
		projectId: "project-1",
		nodes: [{ data: { type: "trigger", config: { triggerType: "Webhook" } } }],
		edges: [],
		specVersion: null,
		spec: {
			do: [{ plan: { call: "agent.run" } }, { repair: { call: "agent.run" } }],
		},
		visibility: "private",
		engineType: "dapr",
		daprWorkflowName: null,
		daprOrchestratorUrl: null,
		mlflowExperimentId: null,
		mlflowExperimentName: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		...overrides,
	};
}

function executionRecord(
	overrides: Partial<WorkflowExecutionRecord> = {},
): WorkflowExecutionRecord {
	return {
		id: "exec-1",
		workflowId: "workflow-1",
		userId: "user-1",
		projectId: "project-1",
		status: "running",
		input: null,
		output: null,
		executionIrVersion: null,
		executionIr: null,
		error: null,
		daprInstanceId: "instance-1",
		phase: null,
		progress: null,
		currentNodeId: null,
		currentNodeName: null,
		primaryTraceId: null,
		workflowSessionId: null,
		mlflowExperimentId: null,
		mlflowRunId: null,
		summaryOutput: null,
		errorStackTrace: null,
		rerunOfExecutionId: null,
		rerunSourceInstanceId: null,
		resumeFromNode: null,
		seedWorkspaceFrom: null,
		triggerSource: null,
		rerunFromEventId: null,
		startedAt: new Date("2026-01-01T00:00:00.000Z"),
		completedAt: null,
		duration: null,
		stopRequestedAt: null,
		stopReason: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Dynamic-script approval gates (cutover P1d): approve()/waitForEvent() gates
// are journal rows with wait_event pause markers, raised at the WAITER child.
// ---------------------------------------------------------------------------
describe("dynamic-script approval gates", () => {
	function gateRow(callId: string, over: Record<string, unknown> = {}) {
		return {
			callId,
			status: "running",
			label: "ship gate",
			result: {
				pause: {
					type: "EVENT",
					eventName: `script.event.${callId}`,
					logicalName: "approval",
					waiterInstanceId: `root__durable-script__${callId.slice(0, 16)}__run__0`,
					message: "ship it?",
					...over,
				},
			},
		};
	}

	function makeScriptService(rows: unknown[]) {
		const approvalEvents: WorkflowApprovalEventPort = {
			raiseApprovalEvent: vi.fn(async () => ({ ok: true as const })),
			raiseWorkflowEvent: vi.fn(async () => ({ ok: true as const })),
		};
		const workflowData = {
			getExecutionById: vi.fn(async () =>
				executionRecord({ executionIrVersion: "dynamic-script-2" }),
			),
			getScopedExecutionById: vi.fn(async () =>
				executionRecord({ executionIrVersion: "dynamic-script-2" }),
			),
			getWorkflowByRef: vi.fn(async () => workflowDefinition()),
			getRunningWorkflowExecution: vi.fn(async () => null),
			isPlatformAdmin: vi.fn(async () => true),
			validateApiKeyForUser: vi.fn(async () => ({
				valid: true as const,
				apiKeyId: "key-1",
			})),
		};
		const service = new ApplicationWorkflowExecutionControlService({
			workflowData,
			approvalEvents,
			coordinatorOwners: { getCoordinatorOwner: vi.fn(async () => null) },
			executionLifecycle: {
        checkExecutionAccess: vi.fn(async () => ({
          status: "ok" as const,
          active: true,
        })),
				stopExecution: vi.fn(async () => ({
					confirmed: true,
					notFound: false,
					state: "confirmed",
				})),
			} as unknown as WorkflowExecutionLifecycleControllerPort,
			executionReadModels: {
				assertMigrated: vi.fn(async () => undefined),
			} as unknown as WorkflowExecutionReadModelPort,
      runStarter: {
        startWorkflowRun: vi.fn(),
      } as unknown as WorkflowRunStarterPort,
      workflowSpecs: {
        validate: vi.fn(),
      } as unknown as WorkflowSpecValidatorPort,
			scriptCalls: { listInternal: vi.fn(async () => rows) } as never,
		});
		return { service, approvalEvents };
	}

	it("approves the single waiting gate at the waiter child", async () => {
		const { service, approvalEvents } = makeScriptService([gateRow("abc_0")]);
		const result = await service.approveExecution({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			body: { note: "lgtm" },
		});
		expect(approvalEvents.raiseWorkflowEvent).toHaveBeenCalledWith({
			instanceId: `root__durable-script__${"abc_0".slice(0, 16)}__run__0`,
			eventName: "script.event.abc_0",
			eventData: {
				approved: true,
				approvedBy: "user-1",
				note: "lgtm",
				source: "run-ui",
			},
		});
		expect(result.status).toBe("ok");
	});

	it("rejects (approved: false) still resolves the gate", async () => {
		const { service, approvalEvents } = makeScriptService([gateRow("abc_0")]);
		await service.approveExecution({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			body: { approved: false },
		});
    const call = (approvalEvents.raiseWorkflowEvent as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
		expect(call.eventData.approved).toBe(false);
	});

	it("409s with disambiguation guidance when multiple gates wait", async () => {
		const { service } = makeScriptService([gateRow("abc_0"), gateRow("def_0")]);
		const result = await service.approveExecution({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			body: {},
		});
		expect(result).toMatchObject({ status: "error", httpStatus: 409 });
	});

	it("409s when no gate waits", async () => {
		const { service } = makeScriptService([]);
		const result = await service.approveExecution({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			body: {},
		});
		expect(result).toMatchObject({ status: "error", httpStatus: 409 });
	});

	it("getApprovalState lists plural gates for dynamic-script runs", async () => {
		const { service } = makeScriptService([gateRow("abc_0"), gateRow("def_0")]);
		const result = await service.getApprovalState({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(result).toEqual({
			status: "ok",
			body: {
				awaiting: true,
				gates: [
          {
            callId: "abc_0",
            name: "approval",
            label: "ship gate",
            message: "ship it?",
          },
          {
            callId: "def_0",
            name: "approval",
            label: "ship gate",
            message: "ship it?",
          },
				],
			},
		});
	});
});
