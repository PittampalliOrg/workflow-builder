import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowExecutionWorkspaceService } from "$lib/server/application/workflow-execution-workspace";
import type {
	WorkflowDataService,
	WorkflowExecutionRecord,
	WorkflowExecutionWorkspacePort,
} from "$lib/server/application/ports";

describe("ApplicationWorkflowExecutionWorkspaceService", () => {
	let workflowData: Pick<WorkflowDataService, "getScopedExecutionById">;
	let workspace: WorkflowExecutionWorkspacePort;
	let service: ApplicationWorkflowExecutionWorkspaceService;

	beforeEach(() => {
		workflowData = {
			getScopedExecutionById: vi.fn(async () => executionRecord()),
		};
		workspace = {
			listTree: vi.fn(async () => ({
				entries: [{ path: "src/index.ts", isDir: false, sizeBytes: 42 }],
				truncated: false,
			})),
			readFile: vi.fn(async () => ({
				bytes: new TextEncoder().encode("hello").buffer,
				contentType: "text/plain",
			})),
		};
		service = new ApplicationWorkflowExecutionWorkspaceService({
			workflowData,
			workspace,
		});
	});

	it("lists a scoped workspace tree by Dapr instance id", async () => {
		await expect(
			service.listWorkspaceFiles({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "ok",
			body: {
				entries: [{ path: "src/index.ts", isDir: false, sizeBytes: 42 }],
				truncated: false,
			},
		});
		expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(workspace.listTree).toHaveBeenCalledWith("sw-example-exec-exec-1");
	});

	it("returns an empty workspace tree when no Dapr instance exists", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(
			executionRecord({ daprInstanceId: null }),
		);

		await expect(service.listWorkspaceFiles(commandInput())).resolves.toEqual({
			status: "ok",
			body: { entries: [], truncated: false },
		});
		expect(workspace.listTree).not.toHaveBeenCalled();
	});

	it("hides missing or out-of-scope executions before workspace reads", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(null);

		await expect(service.listWorkspaceFiles(commandInput())).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
		expect(workspace.listTree).not.toHaveBeenCalled();
	});

	it("keeps workspace tree failures as route-safe unavailable payloads", async () => {
		vi.mocked(workspace.listTree).mockRejectedValueOnce(
			new Error("webdav down"),
		);

		await expect(service.listWorkspaceFiles(commandInput())).resolves.toEqual({
			status: "ok",
			body: {
				entries: [],
				truncated: false,
				error: "workspace unavailable",
			},
		});
	});

	it("reads a scoped workspace file by Dapr instance id", async () => {
		const result = await service.readWorkspaceFile({
			...commandInput(),
			path: "src/index.ts",
		});

		expect(result).toMatchObject({
			status: "ok",
			body: { contentType: "text/plain" },
		});
		expect(workspace.readFile).toHaveBeenCalledWith(
			"sw-example-exec-exec-1",
			"src/index.ts",
		);
	});

	it("preserves workspace-content missing workspace and file-not-found errors", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(
			executionRecord({ daprInstanceId: null }),
		);
		await expect(
			service.readWorkspaceFile({ ...commandInput(), path: "src/index.ts" }),
		).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Run has no workspace",
		});

		vi.mocked(workspace.readFile).mockResolvedValueOnce(null);
		await expect(
			service.readWorkspaceFile({ ...commandInput(), path: "missing.txt" }),
		).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "File not found",
		});
	});
});

function commandInput() {
	return {
		executionId: "exec-1",
		userId: "user-1",
		projectId: "project-1",
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
		daprInstanceId: "sw-example-exec-exec-1",
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
