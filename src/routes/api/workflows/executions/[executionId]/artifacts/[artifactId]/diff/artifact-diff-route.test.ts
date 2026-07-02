import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const execution = {
		id: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		status: "running",
	};
	const artifact = {
		id: "artifact-1",
		workflowExecutionId: "exec-1",
		nodeId: "agent",
		slot: "secondary" as const,
		kind: "diff",
		title: "Workspace changes",
		description: null,
		inlinePayload: { patch: "diff --git a/a b/a\n", stats: { files: 1, additions: 1, deletions: 0 } },
		fileId: null,
		contentType: "text/x-diff",
		sizeBytes: 24,
		metadata: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
	};
	const workflowData = {
		getExecutionById: vi.fn(async () => execution),
		getWorkflowArtifactForExecution: vi.fn(async () => artifact),
		getWorkflowFileContent: vi.fn(async () => ({
			summary: {
				id: "file-1",
				name: "diff.patch.gz",
				purpose: "output",
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
	const resolveRunDiffPatch = vi.fn(async (_artifact, options) => {
		await options.getFileContent("file-1");
		return {
			patch: "diff --git a/a b/a\n",
			baseRef: null,
			headRef: null,
			stats: { files: 1, additions: 1, deletions: 0 },
			truncated: false,
		};
	});
	return { execution, artifact, workflowData, resolveRunDiffPatch };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/workflows/run-diff", () => ({
	RUN_DIFF_KIND: "diff",
	resolveRunDiffPatch: mocks.resolveRunDiffPatch,
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1", artifactId: "artifact-1" },
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		...overrides,
	};
}

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
	try {
		const result = await promise;
		expect((result as { status?: number }).status).toBe(status);
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
	}
}

describe("workflow execution artifact diff route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
		mocks.workflowData.getWorkflowArtifactForExecution.mockResolvedValue(mocks.artifact);
		mocks.workflowData.getWorkflowFileContent.mockResolvedValue({
			summary: {
				id: "file-1",
				name: "diff.patch.gz",
				purpose: "output",
				scopeId: "exec-1",
				contentType: "application/gzip",
				sizeBytes: 12,
				sha1: "sha1",
				createdAt: "2026-01-01T00:00:00.000Z",
				archivedAt: null,
			},
			bytes: Buffer.from("diff --git a/a b/a\n"),
		});
		mocks.resolveRunDiffPatch.mockImplementation(async (_artifact, options) => {
			await options.getFileContent("file-1");
			return {
				patch: "diff --git a/a b/a\n",
				baseRef: null,
				headRef: null,
				stats: { files: 1, additions: 1, deletions: 0 },
				truncated: false,
			};
		});
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getWorkflowFileContent.bind(workflowData)");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns the resolved diff artifact", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			patch: "diff --git a/a b/a\n",
			baseRef: null,
			headRef: null,
			stats: { files: 1, additions: 1, deletions: 0 },
			truncated: false,
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.workflowData.getWorkflowArtifactForExecution).toHaveBeenCalledWith({
			executionId: "exec-1",
			artifactId: "artifact-1",
		});
		expect(mocks.resolveRunDiffPatch).toHaveBeenCalledWith(
			mocks.artifact,
			expect.objectContaining({ getFileContent: expect.any(Function) }),
		);
		expect(mocks.workflowData.getWorkflowFileContent).toHaveBeenCalledWith("file-1");
	});

	it("hides executions outside the active workspace before loading artifact data", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.workflowData.getWorkflowArtifactForExecution).not.toHaveBeenCalled();
	});

	it("rejects non-diff artifacts", async () => {
		mocks.workflowData.getWorkflowArtifactForExecution.mockResolvedValueOnce({
			...mocks.artifact,
			kind: "markdown",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.resolveRunDiffPatch).not.toHaveBeenCalled();
	});
});
