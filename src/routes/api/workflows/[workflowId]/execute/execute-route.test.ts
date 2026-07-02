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
	const workflowData = {
		getWorkflowByRef: vi.fn(async () => workflow),
	};
	const startWorkflowRun = vi.fn(async () => ({
		ok: true,
		executionId: "exec-1",
		instanceId: "sw-example-exec-1",
		workflowId: "wf-1",
		workflowName: "Example",
		status: "running" as const,
		reused: false,
	}));
	return { workflow, workflowData, startWorkflowRun };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/workflows/start-run", () => ({
	startWorkflowRun: mocks.startWorkflowRun,
}));

import { POST } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { workflowId: "wf-1" },
		request: new Request("http://localhost", {
			method: "POST",
			body: JSON.stringify({ input: { prompt: "ship it" } }),
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

describe("workflow execute route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getWorkflowByRef.mockResolvedValue(mocks.workflow);
		mocks.startWorkflowRun.mockResolvedValue({
			ok: true,
			executionId: "exec-1",
			instanceId: "sw-example-exec-1",
			workflowId: "wf-1",
			workflowName: "Example",
			status: "running",
			reused: false,
		});
	});

	it("keeps the route behind workflow-data and startWorkflowRun services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("startWorkflowRun");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("starts a workflow through the canonical command service", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			executionId: "exec-1",
			instanceId: "sw-example-exec-1",
			workflowId: "wf-1",
			status: "running",
		});
		expect(mocks.workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "wf-1",
			lookup: "id",
		});
		expect(mocks.startWorkflowRun).toHaveBeenCalledWith({
			workflowId: "wf-1",
			triggerData: { prompt: "ship it" },
			userId: "user-1",
		});
	});

	it("hides workflows outside the active workspace before starting", async () => {
		mocks.workflowData.getWorkflowByRef.mockResolvedValueOnce({
			...mocks.workflow,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(POST(event() as never)), 404);
		expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
	});
});
