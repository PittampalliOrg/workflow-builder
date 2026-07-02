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
		daprInstanceId: "sw-example-exec-exec-1" as string | null,
	};
	const workflowData = {
		getExecutionById: vi.fn(async () => execution),
	};
	const daprFetch = vi.fn(async () => new Response(null, { status: 202 }));
	return { execution, workflowData, daprFetch };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/dapr-client", () => ({
	daprFetch: mocks.daprFetch,
	getOrchestratorUrl: () => "http://orchestrator.test",
}));

import { POST } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1" },
		request: new Request("http://localhost", {
			method: "POST",
			body: JSON.stringify({ eventType: "goal_spec_approval" }),
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

describe("workflow execution approve route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
		mocks.daprFetch.mockResolvedValue(new Response(null, { status: 202 }));
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

	it("raises an approval event for the scoped Dapr workflow instance", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			eventType: "goal_spec_approval",
			instanceId: "sw-example-exec-exec-1",
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.daprFetch).toHaveBeenCalledWith(
			"http://orchestrator.test/api/v2/workflows/sw-example-exec-exec-1/events",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					eventName: "goal_spec_approval",
					eventData: {
						approved: true,
						approvedBy: "user-1",
						source: "run-ui",
					},
				}),
			}),
		);
	});

	it("hides executions outside the active workspace before signaling Dapr", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(POST(event() as never)), 404);
		expect(mocks.daprFetch).not.toHaveBeenCalled();
	});

	it("returns a conflict when no Dapr instance is available", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			daprInstanceId: null,
		});

		await expectHttpStatus(Promise.resolve(POST(event() as never)), 409);
		expect(mocks.daprFetch).not.toHaveBeenCalled();
	});
});
