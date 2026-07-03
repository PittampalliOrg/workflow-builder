import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowDefinitionCommandService } from "$lib/server/application/workflow-definition-commands";
import type {
	WorkflowConnectionRefSyncPort,
	WorkflowDefinition,
} from "$lib/server/application/ports";

describe("ApplicationWorkflowDefinitionCommandService", () => {
	const workflowData = {
		createWorkflowDefinition: vi.fn(),
		updateWorkflowDefinition: vi.fn(),
		getWorkflowByRef: vi.fn(),
		hasActiveWorkflowExecutions: vi.fn(),
		deleteWorkflowDefinition: vi.fn(),
	};
	let connectionRefs: WorkflowConnectionRefSyncPort;
	let service: ApplicationWorkflowDefinitionCommandService;

	beforeEach(() => {
		vi.clearAllMocks();
		workflowData.createWorkflowDefinition.mockResolvedValue(workflowDefinition());
		workflowData.updateWorkflowDefinition.mockResolvedValue(workflowDefinition());
		workflowData.getWorkflowByRef.mockResolvedValue(workflowDefinition());
		workflowData.hasActiveWorkflowExecutions.mockResolvedValue(false);
		workflowData.deleteWorkflowDefinition.mockResolvedValue(undefined);
		connectionRefs = {
			syncWorkflowConnectionRefs: vi.fn(async () => undefined),
		};
		service = new ApplicationWorkflowDefinitionCommandService({
			workflowData,
			connectionRefs,
		});
	});

	it("creates a workflow and syncs connection refs through a port", async () => {
		const result = await service.createWorkflow({
			body: { name: "Example", nodes: [], edges: [], spec: { do: [] } },
			userId: "user-1",
			projectId: "project-1",
		});

		expect(result).toEqual({
			status: "ok",
			httpStatus: 201,
			body: workflowDefinition(),
		});
		expect(workflowData.createWorkflowDefinition).toHaveBeenCalledWith({
			name: "Example",
			nodes: [],
			edges: [],
			engineType: "dapr",
			userId: "user-1",
			projectId: "project-1",
			spec: { do: [] },
		});
		expect(connectionRefs.syncWorkflowConnectionRefs).toHaveBeenCalledWith({
			workflowId: "wf-1",
			nodes: [],
			spec: { do: [] },
		});
	});

	it("updates a workflow and skips connection sync when the workflow is missing", async () => {
		workflowData.updateWorkflowDefinition.mockResolvedValueOnce(null);

		const result = await service.updateWorkflow({
			workflowId: "wf-1",
			body: { name: "Updated", nodes: [], edges: [], spec: { do: [] } },
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 404,
			body: "Workflow not found",
		});
		expect(connectionRefs.syncWorkflowConnectionRefs).not.toHaveBeenCalled();
	});

	it("updates a workflow and syncs the submitted connection refs", async () => {
		const result = await service.updateWorkflow({
			workflowId: "wf-1",
			body: { name: "Updated", nodes: [], edges: [], spec: { do: [] } },
		});

		expect(result).toEqual({
			status: "ok",
			body: workflowDefinition(),
		});
		expect(workflowData.updateWorkflowDefinition).toHaveBeenCalledWith("wf-1", {
			name: "Updated",
			nodes: [],
			edges: [],
			spec: { do: [] },
		});
		expect(connectionRefs.syncWorkflowConnectionRefs).toHaveBeenCalledWith({
			workflowId: "wf-1",
			nodes: [],
			spec: { do: [] },
		});
	});

	it("blocks out-of-scope and active workflow deletes before deletion", async () => {
		workflowData.getWorkflowByRef.mockResolvedValueOnce({
			...workflowDefinition(),
			projectId: "other-project",
		});
		await expect(
			service.deleteWorkflow({
				workflowId: "wf-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			body: "Workflow not found",
		});

		workflowData.hasActiveWorkflowExecutions.mockResolvedValueOnce(true);
		await expect(
			service.deleteWorkflow({
				workflowId: "wf-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 409,
			body: "Stop the running execution before deleting this workflow",
		});
		expect(workflowData.deleteWorkflowDefinition).not.toHaveBeenCalled();
	});

	it("maps terminal execution history foreign-key conflicts", async () => {
		workflowData.deleteWorkflowDefinition.mockRejectedValueOnce({ code: "23503" });

		const result = await service.deleteWorkflow({
			workflowId: "wf-1",
			userId: "user-1",
			projectId: "project-1",
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 409,
			body: "This workflow has execution history and cannot be deleted; archive it instead.",
		});
	});
});

function workflowDefinition(): WorkflowDefinition {
	const now = new Date("2026-01-01T00:00:00.000Z");
	return {
		id: "wf-1",
		name: "Example",
		description: null,
		userId: "user-1",
		projectId: "project-1",
		nodes: [],
		edges: [],
		specVersion: null,
		spec: { do: [] },
		visibility: "private",
		engineType: "dapr",
		daprWorkflowName: null,
		daprOrchestratorUrl: null,
		mlflowExperimentId: null,
		mlflowExperimentName: null,
		createdAt: now,
		updatedAt: now,
	};
}
