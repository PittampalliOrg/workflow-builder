import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowTriggerManagementService } from "$lib/server/application/workflow-trigger-management";
import type { WorkflowTriggerRecord } from "$lib/server/application/ports";

describe("ApplicationWorkflowTriggerManagementService", () => {
	const workflowData = {
		getWorkflowByRef: vi.fn(),
		listWorkflowTriggers: vi.fn(),
		createWorkflowTrigger: vi.fn(),
	};
	let service: ApplicationWorkflowTriggerManagementService;

	beforeEach(() => {
		vi.clearAllMocks();
		workflowData.getWorkflowByRef.mockResolvedValue({
			id: "wf-1",
			userId: "user-1",
			projectId: "project-1",
		});
		workflowData.listWorkflowTriggers.mockResolvedValue([triggerRow()]);
		workflowData.createWorkflowTrigger.mockResolvedValue(triggerRow());
		service = new ApplicationWorkflowTriggerManagementService({
			workflowData,
			generateDedupSalt: () => "salt",
		});
	});

	it("lists scoped triggers and strips reserved config keys", async () => {
		const result = await service.listTriggers(commandInput());

		expect(result).toEqual({
			status: "ok",
			body: {
				triggers: [
					expect.objectContaining({
						id: "trigger-1",
						config: { visible: true },
					}),
				],
			},
		});
		expect(workflowData.listWorkflowTriggers).toHaveBeenCalledWith("wf-1");
	});

	it("blocks out-of-scope trigger reads before listing rows", async () => {
		workflowData.getWorkflowByRef.mockResolvedValueOnce({
			id: "wf-1",
			userId: "user-2",
			projectId: "project-2",
		});

		const result = await service.listTriggers(commandInput());

		expect(result).toEqual({
			status: "error",
			httpStatus: 404,
			body: "Workflow not found",
		});
		expect(workflowData.listWorkflowTriggers).not.toHaveBeenCalled();
	});

	it("creates an inactive trigger with a generated dedup salt", async () => {
		const result = await service.createTrigger({
			...commandInput(),
			body: {
				kind: "manual",
				config: { visible: true },
				triggerData: { reason: "test" },
			},
		});

		expect(result).toEqual({
			status: "ok",
			httpStatus: 201,
			body: {
				trigger: expect.objectContaining({
					id: "trigger-1",
					config: { visible: true },
				}),
			},
		});
		expect(workflowData.createWorkflowTrigger).toHaveBeenCalledWith({
			workflowId: "wf-1",
			userId: "user-1",
			projectId: "project-1",
			kind: "manual",
			config: { visible: true },
			triggerData: { reason: "test" },
			dedupSalt: "salt",
			status: "inactive",
		});
	});

	it("validates trigger kind and required config before creating rows", async () => {
		await expect(
			service.createTrigger({
				...commandInput(),
				body: { kind: "does-not-exist", config: {} },
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 400,
			body: "Unknown trigger kind: does-not-exist",
		});

		await expect(
			service.createTrigger({
				...commandInput(),
				body: { kind: "github", config: { owner: "PittampalliOrg" } },
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 400,
			body: "Missing required config: repo",
		});
		expect(workflowData.createWorkflowTrigger).not.toHaveBeenCalled();
	});
});

function commandInput() {
	return {
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
	};
}

function triggerRow(): WorkflowTriggerRecord {
	return {
		id: "trigger-1",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		kind: "manual",
		config: { visible: true, __secret: "hidden" },
		triggerData: null,
		dedupSalt: "salt",
		backingRef: null,
		status: "inactive",
		lastError: null,
		lastFiredAt: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}
