import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflow = {
		id: "wf-1",
		name: "Example",
		engineType: "dapr",
		userId: "user-1",
		projectId: "project-1",
		nodes: [],
		edges: [],
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
	const workflowData = {
		listWorkflows: vi.fn(async () => [workflow]),
	};
	const workflowDefinitionCommands = {
		createWorkflow: vi.fn(async () => ({
			status: "ok" as const,
			httpStatus: 201,
			body: workflow,
		}) as unknown),
	};
	return { workflow, workflowData, workflowDefinitionCommands };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: mocks.workflowData,
		workflowDefinitionCommands: mocks.workflowDefinitionCommands,
	}),
}));

import { GET, POST } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		url: new URL("http://localhost/api/workflows?projectOnly=1&limit=25"),
		request: new Request("http://localhost", {
			method: "POST",
			body: JSON.stringify({ name: "Example", nodes: [], edges: [], spec: { do: [] } }),
		}),
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		...overrides,
	};
}

describe("workflows collection route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.listWorkflows.mockResolvedValue([mocks.workflow]);
		mocks.workflowDefinitionCommands.createWorkflow.mockResolvedValue({
			status: "ok",
			httpStatus: 201,
			body: mocks.workflow,
		});
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/workflow-connections");
		expect(source).not.toContain("syncWorkflowConnectionRefs");
	});

	it("lists workflows through workflow-data", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual([
			expect.objectContaining({
				id: "wf-1",
				name: "Example",
				createdAt: "2026-01-01T00:00:00.000Z",
			}),
		]);
		expect(mocks.workflowData.listWorkflows).toHaveBeenCalledWith({
			limit: 25,
			projectId: "project-1",
		});
	});

	it("creates a workflow through workflow definition commands", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toMatchObject({
			id: "wf-1",
			name: "Example",
		});
		expect(mocks.workflowDefinitionCommands.createWorkflow).toHaveBeenCalledWith({
			body: { name: "Example", nodes: [], edges: [], spec: { do: [] } },
			userId: "user-1",
			projectId: "project-1",
		});
	});
});
