import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowTriggerLifecycleService } from "$lib/server/application/workflow-trigger-lifecycle";
import type { WorkflowTriggerLifecyclePort } from "$lib/server/application/ports";

describe("ApplicationWorkflowTriggerLifecycleService", () => {
	const workflowData = {
		getWorkflowByRef: vi.fn(),
		getWorkflowTrigger: vi.fn(),
		deleteWorkflowTrigger: vi.fn(),
	};
	let lifecycle: WorkflowTriggerLifecyclePort;
	let service: ApplicationWorkflowTriggerLifecycleService;

	beforeEach(() => {
		vi.clearAllMocks();
		workflowData.getWorkflowByRef.mockResolvedValue({
			userId: "user-1",
			projectId: "project-1",
		});
		workflowData.getWorkflowTrigger.mockResolvedValue({
			id: "trigger-1",
			workflowId: "wf-1",
		});
		workflowData.deleteWorkflowTrigger.mockResolvedValue(undefined);
		lifecycle = {
			activateTrigger: vi.fn(async () => ({ ok: true as const, status: "active" })),
			deactivateTrigger: vi.fn(async () => ({
				ok: true as const,
				status: "inactive",
			})),
		};
		service = new ApplicationWorkflowTriggerLifecycleService({
			workflowData,
			lifecycle,
		});
	});

	it("activates a trigger after workflow and trigger scope checks", async () => {
		const result = await service.activateTrigger(commandInput());

		expect(result).toEqual({
			status: "ok",
			body: { success: true, status: "active" },
		});
		expect(workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "wf-1",
			lookup: "id",
		});
		expect(workflowData.getWorkflowTrigger).toHaveBeenCalledWith({
			workflowId: "wf-1",
			triggerId: "trigger-1",
		});
		expect(lifecycle.activateTrigger).toHaveBeenCalledWith("trigger-1");
	});

	it("does not call lifecycle when the workflow is outside caller scope", async () => {
		workflowData.getWorkflowByRef.mockResolvedValueOnce({
			userId: "user-2",
			projectId: "project-2",
		});

		const result = await service.activateTrigger(commandInput());

		expect(result).toEqual({
			status: "error",
			httpStatus: 404,
			body: "Workflow not found",
		});
		expect(lifecycle.activateTrigger).not.toHaveBeenCalled();
	});

	it("does not call lifecycle when the trigger is missing", async () => {
		workflowData.getWorkflowTrigger.mockResolvedValueOnce(null);

		const result = await service.deactivateTrigger(commandInput());

		expect(result).toEqual({
			status: "error",
			httpStatus: 404,
			body: "Trigger not found",
		});
		expect(lifecycle.deactivateTrigger).not.toHaveBeenCalled();
	});

	it("maps lifecycle activation failures to the existing 502 response body", async () => {
		vi.mocked(lifecycle.activateTrigger).mockResolvedValueOnce({
			ok: false,
			error: "activation failed",
		});

		const result = await service.activateTrigger(commandInput());

		expect(result).toEqual({
			status: "error",
			httpStatus: 502,
			body: { error: "activation failed" },
		});
	});

	it("deactivates best-effort before deleting the trigger row", async () => {
		vi.mocked(lifecycle.deactivateTrigger).mockResolvedValueOnce({
			ok: false,
			error: "already gone",
		});

		const result = await service.deleteTrigger(commandInput());

		expect(result).toEqual({
			status: "ok",
			body: { success: true },
		});
		expect(lifecycle.deactivateTrigger).toHaveBeenCalledWith("trigger-1");
		expect(workflowData.deleteWorkflowTrigger).toHaveBeenCalledWith("trigger-1");
	});
});

function commandInput() {
	return {
		workflowId: "wf-1",
		triggerId: "trigger-1",
		userId: "user-1",
		projectId: "project-1",
	};
}
