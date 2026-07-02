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
		input: { prompt: "ship it" },
		output: null,
		executionIrVersion: null,
		executionIr: null,
		error: null,
		daprInstanceId: "sw-example-exec-exec-1",
		phase: "running",
		progress: 50,
		currentNodeId: "agent",
		currentNodeName: "Agent",
		primaryTraceId: null,
		workflowSessionId: "exec-1",
		mlflowExperimentId: null,
		mlflowRunId: null,
		summaryOutput: null,
		errorStackTrace: null,
		rerunOfExecutionId: null,
		rerunSourceInstanceId: null,
		resumeFromNode: null,
		triggerSource: null,
		rerunFromEventId: null,
		startedAt: new Date("2026-01-01T00:00:00.000Z"),
		completedAt: null,
		duration: null,
		stopRequestedAt: null,
		stopReason: null,
	};
	const workflowData = {
		getExecutionById: vi.fn(async () => execution),
	};
	const ownsBenchmarkOrEvalRun = vi.fn(async () => ({
		kind: "benchmark",
		runId: "bench-1",
	}));
	return { execution, workflowData, ownsBenchmarkOrEvalRun };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/lifecycle/ownership", () => ({
	ownsBenchmarkOrEvalRun: mocks.ownsBenchmarkOrEvalRun,
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

	it("returns execution detail and ownership through service seams", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			id: "exec-1",
			workflowId: "wf-1",
			owner: { kind: "benchmark", runId: "bench-1" },
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.ownsBenchmarkOrEvalRun).toHaveBeenCalledWith("exec-1");
	});

	it("hides executions outside the active workspace", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.ownsBenchmarkOrEvalRun).not.toHaveBeenCalled();
	});
});
