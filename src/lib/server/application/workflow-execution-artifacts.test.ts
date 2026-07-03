import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowExecutionArtifactsService } from "$lib/server/application/workflow-execution-artifacts";

describe("ApplicationWorkflowExecutionArtifactsService", () => {
	let workflowData: ConstructorParameters<
		typeof ApplicationWorkflowExecutionArtifactsService
	>[0]["workflowData"];
	let service: ApplicationWorkflowExecutionArtifactsService;

	beforeEach(() => {
		workflowData = {
			getScopedExecutionById: vi.fn(async () => ({ id: "exec-1" }) as never),
			listWorkflowArtifactsByExecutionId: vi.fn(async () => [artifactRecord()]),
		};
		service = new ApplicationWorkflowExecutionArtifactsService({ workflowData });
	});

	it("lists artifacts after scoped execution access", async () => {
		await expect(
			service.listArtifacts({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "ok",
			body: { artifacts: [artifactRecord()] },
		});
		expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(workflowData.listWorkflowArtifactsByExecutionId).toHaveBeenCalledWith(
			"exec-1",
		);
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
		expect(workflowData.listWorkflowArtifactsByExecutionId).not.toHaveBeenCalled();
	});

	it("preserves execution lookup failure as a 503 result", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockRejectedValueOnce(
			new Error("read model unavailable"),
		);

		await expect(
			service.listArtifacts({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 503,
			message: "read model unavailable",
		});
		expect(workflowData.listWorkflowArtifactsByExecutionId).not.toHaveBeenCalled();
	});

	it("preserves artifact list failure as a 503 result", async () => {
		vi.mocked(workflowData.listWorkflowArtifactsByExecutionId).mockRejectedValueOnce(
			new Error("artifact store unavailable"),
		);

		await expect(
			service.listArtifacts({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 503,
			message: "artifact store unavailable",
		});
	});
});

function artifactRecord() {
	return {
		id: "artifact-1",
		workflowExecutionId: "exec-1",
		nodeId: "agent",
		slot: "primary" as const,
		kind: "markdown" as const,
		title: "Result",
		description: null,
		inlinePayload: { markdown: "done" },
		fileId: null,
		contentType: null,
		sizeBytes: null,
		metadata: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}
