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
	const workflowData = {
		getExecutionById: vi.fn(async (): Promise<typeof execution | null> => execution),
		persistRunDiffArtifact: vi.fn(async () => ({
			id: "artifact-1",
			fileId: null,
			bytes: 24,
			truncated: false,
		})),
	};
	const requireInternal = vi.fn();
	return { execution, requireInternal, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

import { POST } from "./+server";

function event(body: unknown, overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1" },
		request: new Request(
			"http://localhost/api/internal/workflows/executions/exec-1/run-diff",
			{
				method: "POST",
				body: JSON.stringify(body),
				headers: { "Content-Type": "application/json" },
			},
		),
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

describe("internal workflow execution run-diff ingest route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
		mocks.workflowData.persistRunDiffArtifact.mockResolvedValue({
			id: "artifact-1",
			fileId: null,
			bytes: 24,
			truncated: false,
		});
	});

	it("keeps run-diff ingest behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("requireInternal");
		expect(source).toContain("type { RunDiffStats }");
		expect(source).toContain("workflowData.persistRunDiffArtifact");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("workflowExecutions");
		expect(source).not.toContain("workflowArtifacts");
		expect(source).not.toContain("createFile");
		expect(source).not.toMatch(/import\s+\{[^}]*\bpersistRunDiff\b/);
	});

	it("returns 404 when the execution is missing", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce(null);

		await expectHttpStatus(
			Promise.resolve(POST(event({ patch: "diff --git a/a b/a\n" }) as never)),
			404,
		);
		expect(mocks.workflowData.persistRunDiffArtifact).not.toHaveBeenCalled();
	});

	it("returns an empty result for a blank patch before persistence", async () => {
		const response = (await POST(event({ patch: " \n\t" }) as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true, empty: true });
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.workflowData.persistRunDiffArtifact).not.toHaveBeenCalled();
	});

	it("persists the run diff with execution ownership and request fields", async () => {
		const response = (await POST(
			event({
				patch: "diff --git a/a b/a\n",
				baseRef: "base-sha",
				headRef: "head-sha",
				nodeId: "agent",
				title: "Agent changes",
				stats: { files: 1, additions: 2, deletions: 0 },
			}) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			id: "artifact-1",
			fileId: null,
			bytes: 24,
			truncated: false,
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.workflowData.persistRunDiffArtifact).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			nodeId: "agent",
			title: "Agent changes",
			patch: "diff --git a/a b/a\n",
			baseRef: "base-sha",
			headRef: "head-sha",
			stats: { files: 1, additions: 2, deletions: 0 },
		});
	});
});
