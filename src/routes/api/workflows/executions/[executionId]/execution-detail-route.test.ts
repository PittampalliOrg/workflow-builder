import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";

const mocks = vi.hoisted(() => {
	const workflowExecutionControl = {
		getExecutionDetail: vi.fn(
			async (): Promise<WorkflowExecutionControlResult> => ({
				status: "ok" as const,
				body: {
					id: "exec-1",
					workflowId: "wf-1",
					owner: { kind: "benchmarkRun", runId: "bench-1" },
				},
			}),
		),
	};
	return { workflowExecutionControl };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowExecutionControl: mocks.workflowExecutionControl,
	}),
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

describe("workflow execution detail route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowExecutionControl.getExecutionDetail.mockResolvedValue({
			status: "ok",
			body: {
				id: "exec-1",
				workflowId: "wf-1",
				owner: { kind: "benchmarkRun", runId: "bench-1" },
			},
		});
	});

	it("delegates execution detail reads to the workflow execution control service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionControl.getExecutionDetail");
		expect(source).not.toContain("workflowData.getExecutionById");
		expect(source).not.toContain("$lib/server/lifecycle/ownership");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns execution detail and ownership from the application service", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			id: "exec-1",
			workflowId: "wf-1",
			owner: { kind: "benchmarkRun", runId: "bench-1" },
		});
		expect(mocks.workflowExecutionControl.getExecutionDetail).toHaveBeenCalledWith({
			executionId: "exec-1",
			projectId: "project-1",
			userId: "user-1",
		});
	});

	it("preserves anonymous detail request shape", async () => {
		await GET(event({ locals: {} }) as never);

		expect(mocks.workflowExecutionControl.getExecutionDetail).toHaveBeenCalledWith({
			executionId: "exec-1",
			projectId: null,
			userId: null,
		});
	});

	it("forwards route-safe application errors", async () => {
		mocks.workflowExecutionControl.getExecutionDetail.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});
