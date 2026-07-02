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
		status: "success",
		output: { result: "ok" },
		summaryOutput: null,
	};
	const sourceBundle = {
		id: "artifact-source",
		workflowExecutionId: "exec-1",
		nodeId: "agent",
		slot: "aux" as const,
		kind: "source-bundle",
		title: "Source bundle",
		description: null,
		inlinePayload: { tier: "full", base: "main" },
		fileId: "file-1",
		contentType: "application/x-git-bundle",
		sizeBytes: 123,
		metadata: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
	};
	const markdownArtifact = {
		...sourceBundle,
		id: "artifact-markdown",
		kind: "markdown",
		title: "Summary",
		fileId: null,
	};
	const workflowData = {
		getExecutionById: vi.fn(async () => execution),
		listWorkflowArtifactsByExecutionId: vi.fn(async () => [markdownArtifact, sourceBundle]),
	};
	return { execution, sourceBundle, markdownArtifact, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1" },
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

describe("workflow execution versions route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
		mocks.workflowData.listWorkflowArtifactsByExecutionId.mockResolvedValue([
			mocks.markdownArtifact,
			mocks.sourceBundle,
		]);
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns source-bundle versions and outstanding promotion state", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			versions: [
				{
					artifactId: "artifact-source",
					executionId: "exec-1",
					nodeId: "agent",
					fileId: "file-1",
					sizeBytes: 123,
					title: "Source bundle",
					payload: { tier: "full", base: "main" },
					promotion: null,
					createdAt: "2026-01-01T00:00:00.000Z",
					promotionGate: { allowed: true, reason: "not_required" },
				},
			],
			outstanding: true,
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.workflowData.listWorkflowArtifactsByExecutionId).toHaveBeenCalledWith("exec-1");
	});

	it("hides executions outside the active workspace before listing artifacts", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.workflowData.listWorkflowArtifactsByExecutionId).not.toHaveBeenCalled();
	});
});
