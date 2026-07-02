import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const parentSpec = {
		do: [
			{
				refine: {
					call: "agent.run",
					with: { prompt: "old" },
				},
			},
		],
	};
	const childSpec = {
		do: [
			{
				refine: {
					call: "agent.run",
					with: { prompt: "new" },
				},
			},
			{
				verify: {
					call: "agent.run",
					with: { prompt: "check" },
				},
			},
		],
	};
	const childExecution = {
		id: "exec-child",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		status: "running",
		executionIr: { spec: childSpec },
		rerunOfExecutionId: "exec-parent",
		resumeFromNode: "refine",
	};
	const parentExecution = {
		...childExecution,
		id: "exec-parent",
		executionIr: { spec: parentSpec },
		rerunOfExecutionId: null,
		resumeFromNode: null,
	};
	const workflowData = {
		getExecutionById: vi.fn(async (id: string) =>
			id === "exec-parent" ? parentExecution : childExecution,
		),
	};
	return { childExecution, parentExecution, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-child" },
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

describe("workflow execution spec-diff route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getExecutionById.mockImplementation(async (id: string) =>
			id === "exec-parent" ? mocks.parentExecution : mocks.childExecution,
		);
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

	it("returns a node-level diff between a forked run and its parent", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			hasParent: true,
			parentId: "exec-parent",
			fromNode: "refine",
			snapshotUnavailable: false,
			added: ["verify"],
			removed: [],
			changed: [expect.objectContaining({ name: "refine" })],
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-child");
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-parent");
	});

	it("hides executions outside the active workspace", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.childExecution,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledTimes(1);
	});
});
