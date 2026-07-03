import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";

const mocks = vi.hoisted(() => {
	const workflowExecutionControl = {
		stopExecution: vi.fn(async (): Promise<WorkflowExecutionControlResult> => ({
			status: "ok" as const,
			httpStatus: 202,
			body: {
				ok: false,
				confirmed: false,
				notFound: false,
				state: "stopping",
				requested: true,
				steps: [],
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
			body: JSON.stringify({
				mode: "purge",
				reason: "user requested",
				graceMs: 250,
			}),
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

describe("workflow execution stop route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowExecutionControl.stopExecution.mockResolvedValue({
			status: "ok",
			httpStatus: 202,
			body: {
				ok: false,
				confirmed: false,
				notFound: false,
				state: "stopping",
				requested: true,
				steps: [],
			},
		});
	});

	it("delegates stop commands to the workflow execution control service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionControl.stopExecution");
		expect(source).not.toContain("$lib/server/lifecycle");
		expect(source).not.toContain("$lib/server/lifecycle/ownership");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("inspectDurableRun");
		expect(source).not.toContain("stopDurableRun");
		expect(source).not.toContain("ownsBenchmarkOrEvalRun");
	});

	it("passes stop request details to the application service", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			confirmed: false,
			notFound: false,
			state: "stopping",
			requested: true,
			steps: [],
		});
		expect(mocks.workflowExecutionControl.stopExecution).toHaveBeenCalledWith({
			executionId: "exec-1",
			body: { mode: "purge", reason: "user requested", graceMs: 250 },
			projectId: "project-1",
			userId: "user-1",
		});
	});

	it("forwards route-safe application errors", async () => {
		mocks.workflowExecutionControl.stopExecution.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(POST(event() as never)), 404);
	});

	it("forwards coordinator-owned JSON conflicts from the application service", async () => {
		mocks.workflowExecutionControl.stopExecution.mockResolvedValueOnce({
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
