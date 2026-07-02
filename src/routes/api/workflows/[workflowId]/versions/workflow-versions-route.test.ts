import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflow = {
		id: "wf-1",
		name: "Example",
		userId: "user-1",
		projectId: "project-1",
	};
	const sourceBundle = {
		id: "artifact-source",
		workflowExecutionId: "exec-1",
		nodeId: "agent",
		slot: "aux" as const,
		kind: "source-bundle",
		title: "Source bundle",
		description: null,
		inlinePayload: { tier: "full" },
		fileId: "file-1",
		contentType: "application/x-git-bundle",
		sizeBytes: 123,
		metadata: { promotion: { branch: "wfb-promote-1" } },
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
	};
	const workflowData = {
		getWorkflowByRef: vi.fn(async () => workflow),
		listSourceBundleArtifactsByWorkflowId: vi.fn(async () => [sourceBundle]),
	};
	return { workflow, sourceBundle, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { workflowId: "wf-1" },
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

describe("workflow versions route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getWorkflowByRef.mockResolvedValue(mocks.workflow);
		mocks.workflowData.listSourceBundleArtifactsByWorkflowId.mockResolvedValue([mocks.sourceBundle]);
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

	it("returns source-bundle versions for the scoped workflow", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			versions: [
				{
					artifactId: "artifact-source",
					executionId: "exec-1",
					nodeId: "agent",
					fileId: "file-1",
					sizeBytes: 123,
					title: "Source bundle",
					payload: { tier: "full" },
					promotion: { branch: "wfb-promote-1" },
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});
		expect(mocks.workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "wf-1",
			lookup: "id",
		});
		expect(mocks.workflowData.listSourceBundleArtifactsByWorkflowId).toHaveBeenCalledWith("wf-1");
	});

	it("hides workflows outside the active workspace", async () => {
		mocks.workflowData.getWorkflowByRef.mockResolvedValueOnce({
			...mocks.workflow,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.workflowData.listSourceBundleArtifactsByWorkflowId).not.toHaveBeenCalled();
	});
});
