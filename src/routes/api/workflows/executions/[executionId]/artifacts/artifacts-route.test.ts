import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		getExecutionById: vi.fn(async () => ({
			id: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		})),
		listWorkflowArtifactsByExecutionId: vi.fn(async () => [
			{
				id: "artifact-1",
				workflowExecutionId: "exec-1",
				nodeId: "agent",
				slot: "primary",
				kind: "markdown",
				title: "Result",
				description: null,
				inlinePayload: { markdown: "done" },
				fileId: null,
				contentType: null,
				sizeBytes: null,
				metadata: null,
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
			},
		]),
	};
	return { workflowData };
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

describe("workflow execution artifacts route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps the UI-facing route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns artifacts through workflowData after scoping the execution", async () => {
		const response = (await GET(event() as never)) as Response;
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			artifacts: [
				{
					id: "artifact-1",
					workflowExecutionId: "exec-1",
					kind: "markdown",
					title: "Result",
				},
			],
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.workflowData.listWorkflowArtifactsByExecutionId).toHaveBeenCalledWith("exec-1");
	});

	it("hides artifacts when the execution is outside the active workspace", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			id: "exec-1",
			userId: "user-1",
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.workflowData.listWorkflowArtifactsByExecutionId).not.toHaveBeenCalled();
	});
});
