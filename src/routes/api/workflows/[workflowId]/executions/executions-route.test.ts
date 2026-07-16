import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		getScopedWorkflowById: vi.fn(
			async (): Promise<{ id: string } | null> => ({ id: "wf-1" }),
		),
		listWorkflowExecutions: vi.fn(async () => [
			{
				id: "exec-1",
				workflowId: "wf-1",
				status: "running",
				daprInstanceId: "sw-example-exec-exec-1",
				startedAt: new Date("2026-01-01T00:00:00.000Z"),
				completedAt: null,
				duration: null,
			},
		]),
	};
	return { workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

function event(search = "") {
	return {
		params: { workflowId: "wf-1" },
		url: new URL(`http://workflow-builder.local/test${search}`),
		locals: { session: { userId: "user-1", projectId: "project-1" } },
	};
}

describe("workflow executions list route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getScopedWorkflowById.mockResolvedValue({ id: "wf-1" });
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

	it("lists summary executions through workflowData by default", async () => {
		const response = (await GET(event("?limit=10") as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject([
			{ id: "exec-1", workflowId: "wf-1", status: "running" },
		]);
		expect(mocks.workflowData.listWorkflowExecutions).toHaveBeenCalledWith({
			workflowId: "wf-1",
			limit: 10,
			include: "summary",
		});
	});

	it("does not list executions for an out-of-scope workflow", async () => {
		mocks.workflowData.getScopedWorkflowById.mockResolvedValueOnce(null);

		await expect(GET(event() as never)).rejects.toMatchObject({ status: 404 });
		expect(mocks.workflowData.listWorkflowExecutions).not.toHaveBeenCalled();
	});

	it("preserves include=full", async () => {
		await GET(event("?include=full&limit=5") as never);

		expect(mocks.workflowData.listWorkflowExecutions).toHaveBeenCalledWith({
			workflowId: "wf-1",
			limit: 5,
			include: "full",
		});
	});
});
