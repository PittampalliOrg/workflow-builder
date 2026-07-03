import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowBrowserArtifactsService } from "$lib/server/application/workflow-browser-artifacts";

describe("ApplicationWorkflowBrowserArtifactsService", () => {
	let workflowData: ConstructorParameters<
		typeof ApplicationWorkflowBrowserArtifactsService
	>[0]["workflowData"];
	let service: ApplicationWorkflowBrowserArtifactsService;

	beforeEach(() => {
		workflowData = {
			getScopedExecutionById: vi.fn(async () => ({ id: "exec-1" }) as never),
			listWorkflowBrowserArtifactsByExecutionId: vi.fn(async () => [
				browserArtifact(),
			]),
		};
		service = new ApplicationWorkflowBrowserArtifactsService({ workflowData });
	});

	it("lists browser artifacts after scoped execution access", async () => {
		await expect(
			service.listArtifacts({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "ok",
			body: { artifacts: [browserArtifact()] },
		});
		expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(
			workflowData.listWorkflowBrowserArtifactsByExecutionId,
		).toHaveBeenCalledWith("exec-1");
	});

	it("hides missing or out-of-scope executions before loading artifacts", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(null);

		await expect(
			service.listArtifacts({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
		expect(
			workflowData.listWorkflowBrowserArtifactsByExecutionId,
		).not.toHaveBeenCalled();
	});
});

function browserArtifact() {
	return {
		id: "bwf_1",
		workflowExecutionId: "exec-1",
		workflowId: "wf-1",
		nodeId: "browser",
		workspaceRef: null,
		artifactType: "capture_flow_v1" as const,
		artifactVersion: 1,
		status: "completed" as const,
		manifestJson: {},
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}
