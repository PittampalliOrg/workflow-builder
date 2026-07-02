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
		nodes: [],
		edges: [],
		engineType: "dapr",
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
	const workflowData = {
		getWorkflowByRef: vi.fn(async () => workflow),
		updateWorkflowDefinition: vi.fn(async () => workflow),
		hasActiveWorkflowExecutions: vi.fn(async () => false),
		deleteWorkflowDefinition: vi.fn(async () => undefined),
	};
	const syncWorkflowConnectionRefs = vi.fn(async () => undefined);
	return { workflow, workflowData, syncWorkflowConnectionRefs };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/workflow-connections", () => ({
	syncWorkflowConnectionRefs: mocks.syncWorkflowConnectionRefs,
}));

import { DELETE, GET, PUT } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { workflowId: "wf-1" },
		request: new Request("http://localhost", {
			method: "PUT",
			body: JSON.stringify({ name: "Updated", nodes: [], edges: [], spec: { do: [] } }),
		}),
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

describe("workflow item route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getWorkflowByRef.mockResolvedValue(mocks.workflow);
		mocks.workflowData.updateWorkflowDefinition.mockResolvedValue(mocks.workflow);
		mocks.workflowData.hasActiveWorkflowExecutions.mockResolvedValue(false);
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

	it("loads a workflow through workflow-data", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			id: "wf-1",
			name: "Example",
		});
		expect(mocks.workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "wf-1",
			lookup: "id",
		});
	});

	it("updates a workflow through workflow-data and syncs connection refs", async () => {
		const response = (await PUT(event() as never)) as Response;

		expect(response.status).toBe(200);
		expect(mocks.workflowData.updateWorkflowDefinition).toHaveBeenCalledWith("wf-1", {
			name: "Updated",
			nodes: [],
			edges: [],
			spec: { do: [] },
		});
		expect(mocks.syncWorkflowConnectionRefs).toHaveBeenCalledWith("wf-1", [], { do: [] });
	});

	it("blocks delete when active executions exist", async () => {
		mocks.workflowData.hasActiveWorkflowExecutions.mockResolvedValueOnce(true);

		await expectHttpStatus(Promise.resolve(DELETE(event() as never)), 409);
		expect(mocks.workflowData.deleteWorkflowDefinition).not.toHaveBeenCalled();
	});

	it("deletes scoped workflows through workflow-data", async () => {
		const response = (await DELETE(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ success: true });
		expect(mocks.workflowData.deleteWorkflowDefinition).toHaveBeenCalledWith("wf-1");
	});
});
