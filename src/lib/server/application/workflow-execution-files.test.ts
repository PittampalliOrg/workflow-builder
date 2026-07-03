import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowExecutionFilesService } from "$lib/server/application/workflow-execution-files";

describe("ApplicationWorkflowExecutionFilesService", () => {
	let workflowData: ConstructorParameters<
		typeof ApplicationWorkflowExecutionFilesService
	>[0]["workflowData"];
	let service: ApplicationWorkflowExecutionFilesService;

	beforeEach(() => {
		workflowData = {
			getScopedExecutionById: vi.fn(async () => ({ id: "exec-1" }) as never),
			listExecutionOutputFiles: vi.fn(async () => outputFiles()),
		};
		service = new ApplicationWorkflowExecutionFilesService({ workflowData });
	});

	it("lists persisted output files after scoped execution access", async () => {
		await expect(
			service.listOutputFiles({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "ok",
			body: outputFiles(),
		});
		expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(workflowData.listExecutionOutputFiles).toHaveBeenCalledWith(
			"exec-1",
		);
	});

	it("hides missing or out-of-scope executions before loading files", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(null);

		await expect(
			service.listOutputFiles({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
		expect(workflowData.listExecutionOutputFiles).not.toHaveBeenCalled();
	});
});

function outputFiles() {
	return {
		files: [
			{
				id: "file-1",
				name: "result.txt",
				contentType: "text/plain",
				sizeBytes: 42,
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
			},
		],
		liveSandbox: { name: "workspace-abc" },
		cliWorkspace: false,
	};
}
