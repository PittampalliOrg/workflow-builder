import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";

const mocks = vi.hoisted(() => {
	const workflowExecutionControl = {
		getExecutionStatus: vi.fn(
			async (): Promise<WorkflowExecutionControlResult> => ({
				status: "ok" as const,
				body: {
					id: "exec-1",
					status: "running",
					phase: "running",
					serialized: true,
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
		url: new URL("http://localhost/api/workflows/executions/exec-1/status"),
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

describe("workflow execution status route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowExecutionControl.getExecutionStatus.mockResolvedValue({
			status: "ok",
			body: {
				id: "exec-1",
				status: "running",
				phase: "running",
				serialized: true,
			},
		});
	});

	it("delegates execution status reads to the workflow execution control service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionControl.getExecutionStatus");
		expect(source).not.toContain("workflowData.getExecutionById");
		expect(source).not.toContain("$lib/server/execution-read-model");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("passes status request details to the application service", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			id: "exec-1",
			status: "running",
			phase: "running",
			serialized: true,
		});
		expect(mocks.workflowExecutionControl.getExecutionStatus).toHaveBeenCalledWith({
			executionId: "exec-1",
			includeAgentEvents: false,
			projectId: "project-1",
			userId: "user-1",
		});
	});

	it("passes includeAgentEvents to the application service", async () => {
		const url = new URL("http://localhost/api/workflows/executions/exec-1/status");
		url.searchParams.set("includeAgentEvents", "true");

		await GET(event({ url }) as never);

		expect(mocks.workflowExecutionControl.getExecutionStatus).toHaveBeenCalledWith(
			expect.objectContaining({ includeAgentEvents: true }),
		);
	});

	it("forwards route-safe application errors", async () => {
		mocks.workflowExecutionControl.getExecutionStatus.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});
