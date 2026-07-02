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
		currentNodeId: "goal_spec_approval",
	};
	const workflow = {
		id: "wf-1",
		spec: {
			do: [
				{
					goal_spec_approval: {
						listen: {
							to: {
								one: {
									with: { type: "goal_spec_approval" },
								},
							},
						},
					},
				},
			],
		},
	};
	const workflowData = {
		getExecutionById: vi.fn(async () => execution),
		getWorkflowByRef: vi.fn(async () => workflow),
	};
	return { execution, workflow, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
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

describe("workflow execution approval-state route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
		mocks.workflowData.getWorkflowByRef.mockResolvedValue(mocks.workflow);
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

	it("reports an awaiting approval gate from application service data", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			awaiting: true,
			nodeId: "goal_spec_approval",
			eventType: "goal_spec_approval",
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "wf-1",
			lookup: "id",
		});
	});

	it("does not load workflow spec when the execution is terminal", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			status: "success",
		});

		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ awaiting: false });
		expect(mocks.workflowData.getWorkflowByRef).not.toHaveBeenCalled();
	});

	it("hides executions outside the active workspace", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.workflowData.getWorkflowByRef).not.toHaveBeenCalled();
	});
});
