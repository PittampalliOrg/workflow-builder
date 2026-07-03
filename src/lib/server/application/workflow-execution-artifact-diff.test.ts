import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowExecutionArtifactDiffService } from "$lib/server/application/workflow-execution-artifact-diff";

describe("ApplicationWorkflowExecutionArtifactDiffService", () => {
	let workflowData: ConstructorParameters<
		typeof ApplicationWorkflowExecutionArtifactDiffService
	>[0]["workflowData"];
	let resolveDiff: ConstructorParameters<
		typeof ApplicationWorkflowExecutionArtifactDiffService
	>[0]["resolveDiff"];
	let service: ApplicationWorkflowExecutionArtifactDiffService;

	beforeEach(() => {
		workflowData = {
			getScopedExecutionById: vi.fn(async () => ({ id: "exec-1" }) as never),
			getWorkflowArtifactForExecution: vi.fn(async () => diffArtifact()),
			getWorkflowFileContent: vi.fn(async () => ({
				summary: {
					id: "file-1",
					name: "diff.patch.gz",
					purpose: "output" as const,
					scopeId: "exec-1",
					contentType: "application/gzip",
					sizeBytes: 12,
					sha1: "sha1",
					createdAt: "2026-01-01T00:00:00.000Z",
					archivedAt: null,
				},
				bytes: Buffer.from("diff --git a/a b/a\n"),
			})),
		};
		resolveDiff = vi.fn(async (_artifact, options) => {
			await options.getFileContent("file-1");
			return resolvedDiff();
		});
		service = new ApplicationWorkflowExecutionArtifactDiffService({
			workflowData,
			diffKind: "diff",
			resolveDiff,
		});
	});

	it("resolves a scoped diff artifact", async () => {
		await expect(service.getDiff(commandInput())).resolves.toEqual({
			status: "ok",
			body: resolvedDiff(),
		});
		expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(workflowData.getWorkflowArtifactForExecution).toHaveBeenCalledWith({
			executionId: "exec-1",
			artifactId: "artifact-1",
		});
		expect(resolveDiff).toHaveBeenCalledWith(
			diffArtifact(),
			expect.objectContaining({ getFileContent: expect.any(Function) }),
		);
		expect(workflowData.getWorkflowFileContent).toHaveBeenCalledWith("file-1");
	});

	it("hides out-of-scope executions before loading artifacts", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(null);

		await expect(service.getDiff(commandInput())).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
		expect(workflowData.getWorkflowArtifactForExecution).not.toHaveBeenCalled();
	});

	it("rejects missing or non-diff artifacts", async () => {
		vi.mocked(workflowData.getWorkflowArtifactForExecution).mockResolvedValueOnce(
			null,
		);
		await expect(service.getDiff(commandInput())).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Diff artifact not found",
		});
		expect(resolveDiff).not.toHaveBeenCalled();

		vi.mocked(workflowData.getWorkflowArtifactForExecution).mockResolvedValueOnce({
			...diffArtifact(),
			kind: "markdown",
		});
		await expect(service.getDiff(commandInput())).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Diff artifact not found",
		});
	});

	it("maps unresolved diff payloads to the existing 404", async () => {
		vi.mocked(resolveDiff).mockResolvedValueOnce(null);

		await expect(service.getDiff(commandInput())).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Diff artifact not found",
		});
	});
});

function commandInput() {
	return {
		executionId: "exec-1",
		artifactId: "artifact-1",
		userId: "user-1",
		projectId: "project-1",
	};
}

function diffArtifact() {
	return {
		id: "artifact-1",
		workflowExecutionId: "exec-1",
		nodeId: "agent",
		slot: "secondary" as const,
		kind: "diff",
		title: "Workspace changes",
		description: null,
		inlinePayload: {
			patch: "diff --git a/a b/a\n",
			stats: { files: 1, additions: 1, deletions: 0 },
		},
		fileId: null,
		contentType: "text/x-diff",
		sizeBytes: 24,
		metadata: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

function resolvedDiff() {
	return {
		patch: "diff --git a/a b/a\n",
		baseRef: null,
		headRef: null,
		stats: { files: 1, additions: 1, deletions: 0 },
		truncated: false,
	};
}
