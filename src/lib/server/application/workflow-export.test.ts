import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationWorkflowExportService,
	type WorkflowCodeFunctionPort,
	type WorkflowEmitterPort,
	type WorkflowExportDataPort,
} from "$lib/server/application/workflow-export";

describe("ApplicationWorkflowExportService", () => {
	let workflowData: WorkflowExportDataPort;
	let emitter: WorkflowEmitterPort;
	let codeFunctions: WorkflowCodeFunctionPort;
	let service: ApplicationWorkflowExportService;

	const workflow = {
		id: "wf-1",
		name: "Example",
		userId: "user-1",
		projectId: "project-1",
		spec: { do: [] },
	};

	beforeEach(() => {
		workflowData = {
			getWorkflowByRef: vi.fn(async () => workflow as never),
		};
		emitter = {
			emitWorkflow: vi.fn(async () => ({
				source: "export const workflow = {};",
				supportingFiles: { "runtime.ts": "shim" },
				warnings: ["warn"],
				compositionGraph: { nodes: [] },
				workflowName: "example",
				filename: "example.ts",
			})),
		};
		codeFunctions = {
			createWorkflowCodeFunction: vi.fn(async () => ({
				id: "fn-1",
				slug: "example-workflow",
				name: "Saved workflow",
			})),
		};
		service = new ApplicationWorkflowExportService({
			workflowData,
			emitter,
			codeFunctions,
			now: () => new Date("2026-07-03T12:00:00.000Z"),
		});
	});

	it("returns emitted workflow JSON when requested", async () => {
		await expect(
			service.getExport({
				workflowId: "wf-1",
				session: { userId: "user-1", projectId: "project-1" },
				language: null,
				inlineFunctions: null,
				format: "json",
				download: null,
			}),
		).resolves.toMatchObject({
			status: "json",
			body: {
				source: "export const workflow = {};",
				workflowName: "example",
				filename: "example.ts",
				language: "typescript",
			},
		});

		expect(workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "wf-1",
			lookup: "id",
		});
		expect(emitter.emitWorkflow).toHaveBeenCalledWith(
			{ do: [] },
			{
				language: "typescript",
				userId: "user-1",
				inlineFunctions: true,
			},
		);
	});

	it("returns a downloadable source response for python exports", async () => {
		await expect(
			service.getExport({
				workflowId: "wf-1",
				session: { userId: "user-1", projectId: "project-1" },
				language: "py",
				inlineFunctions: "false",
				format: null,
				download: "true",
			}),
		).resolves.toMatchObject({
			status: "source",
			source: "export const workflow = {};",
			headers: {
				"content-type": "text/x-python",
				"content-disposition": 'attachment; filename="example.ts"',
			},
		});

		expect(emitter.emitWorkflow).toHaveBeenCalledWith(
			{ do: [] },
			expect.objectContaining({
				language: "python",
				inlineFunctions: false,
			}),
		);
	});

	it("saves emitted code as a workflow code function", async () => {
		await expect(
			service.saveExport({
				workflowId: "wf-1",
				session: { userId: "user-1", projectId: "project-1" },
				language: null,
				inlineFunctions: null,
				body: { name: " Saved workflow " },
			}),
		).resolves.toEqual({
			status: "ok",
			body: {
				codeFunctionId: "fn-1",
				slug: "example-workflow",
				name: "Saved workflow",
				warnings: ["warn"],
				compositionGraph: { nodes: [] },
				language: "typescript",
			},
		});

		expect(codeFunctions.createWorkflowCodeFunction).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Saved workflow",
				description:
					'Emitted from workflow "Example" on 2026-07-03T12:00:00.000Z. Warnings: 1.',
				role: "workflow",
			}),
			"user-1",
		);
	});

	it("hides workflows outside the active workspace", async () => {
		vi.mocked(workflowData.getWorkflowByRef).mockResolvedValueOnce({
			...workflow,
			projectId: "project-2",
		} as never);

		await expect(
			service.getExport({
				workflowId: "wf-1",
				session: { userId: "user-1", projectId: "project-1" },
				language: null,
				inlineFunctions: null,
				format: "json",
				download: null,
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			body: "Workflow not found",
		});
		expect(emitter.emitWorkflow).not.toHaveBeenCalled();
	});

	it("rejects workflows without an exportable spec", async () => {
		vi.mocked(workflowData.getWorkflowByRef).mockResolvedValueOnce({
			...workflow,
			spec: null,
		} as never);

		await expect(
			service.getExport({
				workflowId: "wf-1",
				session: { userId: "user-1", projectId: "project-1" },
				language: null,
				inlineFunctions: null,
				format: "json",
				download: null,
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 400,
			body: "Workflow has no SW 1.0 spec. Save the workflow first before exporting.",
		});
	});
});
