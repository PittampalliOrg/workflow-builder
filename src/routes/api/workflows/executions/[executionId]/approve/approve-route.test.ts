import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";

const mocks = vi.hoisted(() => {
	const workflowExecutionControl = {
		approveExecution: vi.fn(async (): Promise<WorkflowExecutionControlResult> => ({
			status: "ok" as const,
			body: {
				ok: true,
				eventType: "goal_spec_approval",
				instanceId: "sw-example-exec-exec-1",
			},
		})),
	};
	return { workflowExecutionControl };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowExecutionControl: mocks.workflowExecutionControl,
	}),
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
		mocks.workflowExecutionControl.approveExecution.mockResolvedValue({
			status: "ok",
			body: {
				ok: true,
				eventType: "goal_spec_approval",
				instanceId: "sw-example-exec-exec-1",
			},
		});
	});

	it("delegates approval commands to the workflow execution control service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionControl.approveExecution");
		expect(source).not.toContain("workflowData.getExecutionById");
		expect(source).not.toContain("$lib/server/dapr-client");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("passes the approval request to the application service", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			eventType: "goal_spec_approval",
			instanceId: "sw-example-exec-exec-1",
		});
		expect(mocks.workflowExecutionControl.approveExecution).toHaveBeenCalledWith({
			executionId: "exec-1",
			body: { eventType: "goal_spec_approval" },
			projectId: "project-1",
			userId: "user-1",
		});
	});

	it("forwards route-safe application errors", async () => {
		mocks.workflowExecutionControl.approveExecution.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(POST(event() as never)), 404);
	});

	it("passes empty event type bodies through to the application service", async () => {
		await POST(
			event({
				request: new Request("http://localhost", {
					method: "POST",
					body: JSON.stringify({ eventType: "" }),
				}),
			}) as never,
		);

		expect(mocks.workflowExecutionControl.approveExecution).toHaveBeenCalledWith(
			expect.objectContaining({
				body: { eventType: "" },
			}),
		);
	});
});
