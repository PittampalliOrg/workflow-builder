import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflow = {
		id: "wf-1",
		name: "Example",
		description: "desc",
		userId: "user-1",
		projectId: "project-1",
		nodes: [{ id: "n1" }],
		edges: [],
		spec: { document: { dsl: "1.0.0" }, metadata: {} },
		daprWorkflowName: null,
	};
	const updated = {
		...workflow,
		daprWorkflowName: "wf_wf-1",
	};
	const workflowData = {
		getWorkflowByRef: vi.fn(async (): Promise<typeof workflow | null> => workflow),
		updateWorkflowDefinition: vi.fn(async () => updated),
	};
	return { workflow, updated, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("nanoid", () => ({
	nanoid: () => "abc123",
}));

import { POST } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { workflowId: "wf-1" },
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

describe("workflow publish route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getWorkflowByRef.mockResolvedValue(mocks.workflow);
		mocks.workflowData.updateWorkflowDefinition.mockResolvedValue(mocks.updated);
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

	it("publishes a frozen revision through workflow-data", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			id: "wf-1",
			daprWorkflowName: "wf_wf-1",
		});
		expect(mocks.workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "wf-1",
			lookup: "id",
		});
		expect(mocks.workflowData.updateWorkflowDefinition).toHaveBeenCalledWith(
			"wf-1",
			expect.objectContaining({
				daprWorkflowName: "wf_wf-1",
				spec: expect.objectContaining({
					metadata: expect.objectContaining({
						publishedRuntime: expect.objectContaining({
							latestVersion: expect.stringMatching(/^pub_/),
							revisions: [
								expect.objectContaining({
									nodes: [{ id: "n1" }],
									edges: [],
									name: "Example",
									description: "desc",
								}),
							],
						}),
					}),
				}),
			}),
		);
	});

	it("returns 404 for missing workflows", async () => {
		mocks.workflowData.getWorkflowByRef.mockResolvedValueOnce(null);

		await expectHttpStatus(Promise.resolve(POST(event() as never)), 404);
		expect(mocks.workflowData.updateWorkflowDefinition).not.toHaveBeenCalled();
	});
});
