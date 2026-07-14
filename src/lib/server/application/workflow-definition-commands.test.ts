import { beforeEach, describe, expect, it, vi } from "vitest";

const { privateEnv } = vi.hoisted(() => ({
	privateEnv: {} as Record<string, string | undefined>,
}));
vi.mock("$env/dynamic/private", () => ({ env: privateEnv }));

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

	it("publishes a frozen workflow revision through workflow-data", async () => {
		const result = await service.publishWorkflow({ workflowId: "wf-1" });

		expect(result).toEqual({
			status: "ok",
			body: workflowDefinition(),
		});
		expect(workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "wf-1",
			lookup: "id",
		});
		expect(workflowData.updateWorkflowDefinition).toHaveBeenCalledWith(
			"wf-1",
			expect.objectContaining({
				daprWorkflowName: "wf_wf-1",
				spec: expect.objectContaining({
					metadata: expect.objectContaining({
						publishedRuntime: expect.objectContaining({
							latestVersion: expect.stringMatching(/^pub_/),
							revisions: [
								expect.objectContaining({
									version: expect.stringMatching(/^pub_/),
									publishedAt: expect.any(String),
									nodes: [],
									edges: [],
									name: "Example",
									description: null,
								}),
							],
						}),
					}),
				}),
			}),
		);
	});

	it("returns not found for missing workflow publications", async () => {
		workflowData.getWorkflowByRef.mockResolvedValueOnce(null);

		await expect(
			service.publishWorkflow({ workflowId: "missing" }),
		).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			body: "Workflow not found",
		});
		expect(workflowData.updateWorkflowDefinition).not.toHaveBeenCalled();
	});

	it("returns the latest published workflow version projection", async () => {
		workflowData.getWorkflowByRef.mockResolvedValueOnce({
			...workflowDefinition(),
			spec: {
				metadata: {
					publishedRuntime: {
						revisions: [
							{
								version: "pub_1",
								publishedAt: "2026-01-01T00:00:00.000Z",
								nodes: [{ id: "n1" }],
								edges: [],
								name: "First",
								description: "first version",
							},
							{
								version: "pub_2",
								publishedAt: "2026-01-02T00:00:00.000Z",
								nodes: [{ id: "n2" }],
								edges: [],
								name: "Second",
								description: "second version",
							},
						],
					},
				},
			},
		});

		await expect(
			service.getPublishedWorkflowVersion({
				workflowId: "wf-1",
				version: "latest",
			}),
		).resolves.toEqual({
			status: "ok",
			body: {
				workflowId: "wf-1",
				version: "pub_2",
				publishedAt: "2026-01-02T00:00:00.000Z",
				definition: {
					name: "Second",
					description: "second version",
					nodes: [{ id: "n2" }],
					edges: [],
				},
				revisions: [
					{ version: "pub_1", publishedAt: "2026-01-01T00:00:00.000Z" },
					{ version: "pub_2", publishedAt: "2026-01-02T00:00:00.000Z" },
				],
			},
		});
	});

	it("returns not found when a published workflow version is missing", async () => {
		await expect(
			service.getPublishedWorkflowVersion({
				workflowId: "wf-1",
				version: "missing",
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			body: "No published versions found",
		});
	});

	// ── P4 freeze (cutover item 18) ──────────────────────────────────────────
	describe("SW authoring freeze", () => {
		it("rejects explicit SW creation, allows internal override, defaults to script", async () => {
			privateEnv.SW_AUTHORING_FROZEN = "true";

			const rejected = await service.createWorkflow({
				body: { name: "legacy", engineType: "dapr" },
				userId: "u1",
				projectId: "p1",
			});
			expect(rejected).toMatchObject({ status: "error", httpStatus: 400 });

			const allowed = await service.createWorkflow({
				body: { name: "system", engineType: "dapr" },
				userId: "u1",
				projectId: "p1",
				internalOverride: true,
			});
			expect(allowed.status).toBe("ok");

			await service.createWorkflow({ body: { name: "new" }, userId: "u1", projectId: "p1" });
			const lastCall = workflowData.createWorkflowDefinition.mock.calls.at(-1)?.[0];
			expect(lastCall.engineType).toBe("dynamic-script");
			delete privateEnv.SW_AUTHORING_FROZEN;
		});

		it("rejects SW spec writes while the freeze is on", async () => {
			privateEnv.SW_AUTHORING_FROZEN = "true";
			const res = await service.updateWorkflow({
				workflowId: "wf-1",
				body: { spec: { document: { dsl: "1.0.0", name: "x" }, do: [] } },
			});
			expect(res).toMatchObject({ status: "error", httpStatus: 400 });
			delete privateEnv.SW_AUTHORING_FROZEN;
		});

		it("is OFF by default: SW creation still works", async () => {
			const res = await service.createWorkflow({
				body: { name: "legacy", engineType: "dapr" },
				userId: "u1",
				projectId: "p1",
			});
			expect(res.status).toBe("ok");
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
