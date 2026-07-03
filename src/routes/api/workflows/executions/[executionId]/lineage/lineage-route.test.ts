import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const execution = {
		id: "exec-1",
		userId: "user-1",
		projectId: "project-1",
	};
	const workflowData = {
		getScopedExecutionById: vi.fn(async (): Promise<typeof execution | null> => execution),
		getExecutionLineage: vi.fn(async () => ({
			rootId: "root-exec",
			currentId: "exec-1",
			nodes: [
				{
					id: "root-exec",
					status: "success",
					fromNodeId: null,
					parentId: null,
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: "2026-01-01T00:01:00.000Z",
					durationMs: 60_000,
					isCurrent: false,
				},
				{
					id: "exec-1",
					status: "running",
					fromNodeId: "agent",
					parentId: "root-exec",
					startedAt: "2026-01-01T00:02:00.000Z",
					completedAt: null,
					durationMs: null,
					isCurrent: true,
				},
			],
		})),
	};
	return { execution, workflowData };
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

describe("workflow execution lineage route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps the UI-facing route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getScopedExecutionById");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns lineage through workflowData after scoping the execution", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			rootId: "root-exec",
			currentId: "exec-1",
			nodes: [{ id: "root-exec" }, { id: "exec-1", isCurrent: true }],
		});
		expect(mocks.workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(mocks.workflowData.getExecutionLineage).toHaveBeenCalledWith("exec-1");
	});

	it("does not load lineage outside the active workspace", async () => {
		mocks.workflowData.getScopedExecutionById.mockResolvedValueOnce(null);

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.workflowData.getExecutionLineage).not.toHaveBeenCalled();
	});
});
