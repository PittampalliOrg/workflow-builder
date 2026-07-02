import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const sourceExecution = {
		id: "exec-child",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		status: "error",
		input: { repoUrl: "owner/repo" },
		daprInstanceId: "sw-example-exec-child",
		currentNodeId: "repair",
		rerunOfExecutionId: "exec-root",
	};
	const rootExecution = {
		...sourceExecution,
		id: "exec-root",
		daprInstanceId: "sw-example-exec-root",
		rerunOfExecutionId: null,
	};
	const workflow = {
		id: "wf-1",
		spec: {
			do: [
				{ plan: { call: "agent.run" } },
				{ repair: { call: "agent.run" } },
			],
		},
	};
	const workflowData = {
		getExecutionById: vi.fn(async (id: string) =>
			id === "exec-root" ? rootExecution : sourceExecution,
		),
		getWorkflowByRef: vi.fn(async () => workflow),
	};
	const ownsBenchmarkOrEvalRun = vi.fn(
		async (): Promise<null | { kind: string; runId: string }> => null,
	);
	const startWorkflowRun = vi.fn(async () => ({
		ok: true,
		executionId: "exec-new",
		instanceId: "sw-example-exec-new",
	}));
	return {
		sourceExecution,
		rootExecution,
		workflow,
		workflowData,
		ownsBenchmarkOrEvalRun,
		startWorkflowRun,
	};
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/lifecycle/ownership", () => ({
	ownsBenchmarkOrEvalRun: mocks.ownsBenchmarkOrEvalRun,
}));

vi.mock("$lib/server/workflows/start-run", () => ({
	startWorkflowRun: mocks.startWorkflowRun,
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
		mocks.workflowData.getExecutionById.mockImplementation(async (id: string) =>
			id === "exec-root" ? mocks.rootExecution : mocks.sourceExecution,
		);
		mocks.workflowData.getWorkflowByRef.mockResolvedValue(mocks.workflow);
		mocks.ownsBenchmarkOrEvalRun.mockResolvedValue(null);
		mocks.startWorkflowRun.mockResolvedValue({
			ok: true,
			executionId: "exec-new",
			instanceId: "sw-example-exec-new",
		});
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

	it("starts a fresh resumed run from the current workflow spec", async () => {
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
		expect(mocks.workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "wf-1",
			lookup: "id",
		});
		expect(mocks.startWorkflowRun).toHaveBeenCalledWith({
			workflowId: "wf-1",
			triggerData: { repoUrl: "owner/repo" },
			resumeFromNode: "repair",
			seedWorkspaceFrom: "sw-example-exec-root",
			rerunOfExecutionId: "exec-child",
			rerunSourceInstanceId: "sw-example-exec-child",
			triggerSource: "resume",
		});
	});

	it("rejects coordinator-owned benchmark/eval executions", async () => {
		mocks.ownsBenchmarkOrEvalRun.mockResolvedValueOnce({
			kind: "benchmark",
			runId: "bench-1",
		});

		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			error: "coordinator_owned",
			ownedBy: "benchmark",
			runId: "bench-1",
		});
		expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
	});

	it("hides executions outside the active workspace", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.sourceExecution,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(POST(event() as never)), 404);
		expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
	});
});
