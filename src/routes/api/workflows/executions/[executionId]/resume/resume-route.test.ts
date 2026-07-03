import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";

const mocks = vi.hoisted(() => {
	const workflowExecutionControl = {
		resumeExecution: vi.fn(async (): Promise<WorkflowExecutionControlResult> => ({
			status: "ok" as const,
			body: {
				ok: true,
				executionId: "exec-new",
				sourceExecutionId: "exec-child",
				newInstanceId: "sw-example-exec-new",
				fromNodeId: "repair",
				seedWorkspaceFrom: "sw-example-exec-root",
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
		params: { executionId: "exec-child" },
		request: new Request("http://localhost", {
			method: "POST",
			body: JSON.stringify({ fromNodeId: "/do/1/repair" }),
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

describe("workflow execution resume route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowExecutionControl.resumeExecution.mockResolvedValue({
			status: "ok",
			body: {
				ok: true,
				executionId: "exec-new",
				sourceExecutionId: "exec-child",
				newInstanceId: "sw-example-exec-new",
				fromNodeId: "repair",
				seedWorkspaceFrom: "sw-example-exec-root",
			},
		});
	});

	it("delegates resume commands to the workflow execution control service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionControl.resumeExecution");
		expect(source).not.toContain("workflowData.getExecutionById");
		expect(source).not.toContain("getWorkflowByRef");
		expect(source).not.toContain("$lib/server/workflows/start-run");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/lifecycle/ownership");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("passes the resume request to the application service", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			executionId: "exec-new",
			sourceExecutionId: "exec-child",
			newInstanceId: "sw-example-exec-new",
			fromNodeId: "repair",
			seedWorkspaceFrom: "sw-example-exec-root",
		});
		expect(mocks.workflowExecutionControl.resumeExecution).toHaveBeenCalledWith({
			executionId: "exec-child",
			body: { fromNodeId: "/do/1/repair" },
			projectId: "project-1",
			userId: "user-1",
		});
	});

	it("forwards route-safe application errors", async () => {
		mocks.workflowExecutionControl.resumeExecution.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(POST(event() as never)), 404);
	});

	it("forwards coordinator-owned JSON conflicts from the application service", async () => {
		mocks.workflowExecutionControl.resumeExecution.mockResolvedValueOnce({
			status: "ok",
			httpStatus: 409,
			body: {
				ok: false,
				error: "coordinator_owned",
				ownedBy: "benchmarkRun",
				runId: "bench-1",
			},
		});

		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			error: "coordinator_owned",
			ownedBy: "benchmarkRun",
			runId: "bench-1",
		});
	});
});
