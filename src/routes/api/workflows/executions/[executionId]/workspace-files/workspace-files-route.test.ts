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
		daprInstanceId: "sw-example-exec-exec-1" as string | null,
	};
	const workflowData = {
		getExecutionById: vi.fn(async () => execution),
	};
	const listWorkspaceTree = vi.fn(async () => ({
		entries: [{ path: "src/index.ts", type: "file", size: 42 }],
		truncated: false,
	}));
	return { execution, workflowData, listWorkspaceTree };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/workflows/juicefs-webdav", () => ({
	listWorkspaceTree: mocks.listWorkspaceTree,
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

describe("workflow execution workspace-files route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
		mocks.listWorkspaceTree.mockResolvedValue({
			entries: [{ path: "src/index.ts", type: "file", size: 42 }],
			truncated: false,
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

	it("lists the scoped workspace tree by Dapr instance id", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			entries: [{ path: "src/index.ts", type: "file", size: 42 }],
			truncated: false,
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.listWorkspaceTree).toHaveBeenCalledWith("sw-example-exec-exec-1");
	});

	it("returns an empty tree when no workspace instance exists", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			daprInstanceId: null,
		});

		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ entries: [], truncated: false });
		expect(mocks.listWorkspaceTree).not.toHaveBeenCalled();
	});

	it("hides executions outside the active workspace", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.listWorkspaceTree).not.toHaveBeenCalled();
	});
});
