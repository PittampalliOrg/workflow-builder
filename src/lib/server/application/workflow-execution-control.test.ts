import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowExecutionControlService } from "$lib/server/application/workflow-execution-control";
import type {
	WorkflowApprovalEventPort,
	WorkflowDataService,
	WorkflowExecutionRecord,
} from "$lib/server/application/ports";

describe("ApplicationWorkflowExecutionControlService", () => {
	let workflowData: Pick<WorkflowDataService, "getExecutionById">;
	let approvalEvents: WorkflowApprovalEventPort;
	let service: ApplicationWorkflowExecutionControlService;

	beforeEach(() => {
		workflowData = {
			getExecutionById: vi.fn(async () => executionRecord()),
		};
		approvalEvents = {
			raiseApprovalEvent: vi.fn(async () => ({ ok: true as const })),
		};
		service = new ApplicationWorkflowExecutionControlService({
			workflowData,
			approvalEvents,
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

	it("returns conflict when no Dapr instance is available", async () => {
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
});

function commandInput() {
	return {
		executionId: "exec-1",
		userId: "user-1",
		projectId: "project-1",
		body: { eventType: "goal_spec_approval" },
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
