import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowExecutionControlService } from "$lib/server/application/workflow-execution-control";
import type {
	WorkflowApprovalEventPort,
	WorkflowDataService,
	WorkflowDefinition,
	WorkflowExecutionCoordinatorOwnerPort,
	WorkflowExecutionRecord,
	WorkflowRunStarterPort,
} from "$lib/server/application/ports";

describe("ApplicationWorkflowExecutionControlService", () => {
	let workflowData: Pick<
		WorkflowDataService,
		"getExecutionById" | "getWorkflowByRef"
	>;
	let approvalEvents: WorkflowApprovalEventPort;
	let coordinatorOwners: WorkflowExecutionCoordinatorOwnerPort;
	let runStarter: WorkflowRunStarterPort;
	let service: ApplicationWorkflowExecutionControlService;

	beforeEach(() => {
		workflowData = {
			getExecutionById: vi.fn(async () => executionRecord()),
			getWorkflowByRef: vi.fn(async () => workflowDefinition()),
		};
		approvalEvents = {
			raiseApprovalEvent: vi.fn(async () => ({ ok: true as const })),
		};
		coordinatorOwners = {
			getCoordinatorOwner: vi.fn(async () => null),
		};
		runStarter = {
			startWorkflowRun: vi.fn(async () => ({
				ok: true as const,
				executionId: "exec-new",
				instanceId: "instance-new",
			})),
		};
		service = new ApplicationWorkflowExecutionControlService({
			workflowData,
			approvalEvents,
			coordinatorOwners,
			runStarter,
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
			},
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
		nodes: [],
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
