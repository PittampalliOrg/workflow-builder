import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";

const mocks = vi.hoisted(() => {
	const workflowExecutionControl = {
		executeWorkflow: vi.fn(async (): Promise<WorkflowExecutionControlResult> => ({
			status: "ok" as const,
			body: {
				executionId: "exec-1",
				instanceId: "sw-example-exec-1",
				workflowId: "wf-1",
				status: "running",
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
		mocks.workflowExecutionControl.executeWorkflow.mockResolvedValue({
			status: "ok",
			body: {
				executionId: "exec-1",
				instanceId: "sw-example-exec-1",
				workflowId: "wf-1",
				status: "running",
			},
		});
	});

	it("delegates execute commands to the workflow execution control service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionControl.executeWorkflow");
		expect(source).not.toContain("workflowData.getWorkflowByRef");
		expect(source).not.toContain("startWorkflowRun");
		expect(source).not.toContain("assertInScope");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("passes the execution request to the application service", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			executionId: "exec-1",
			instanceId: "sw-example-exec-1",
			workflowId: "wf-1",
			status: "running",
		});
		expect(mocks.workflowExecutionControl.executeWorkflow).toHaveBeenCalledWith({
			workflowId: "wf-1",
			body: { input: { prompt: "ship it" } },
			projectId: "project-1",
			userId: "user-1",
		});
	});

	it("forwards route-safe application errors", async () => {
		mocks.workflowExecutionControl.executeWorkflow.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Workflow not found",
		});

		await expectHttpStatus(Promise.resolve(POST(event() as never)), 404);
	});
});
