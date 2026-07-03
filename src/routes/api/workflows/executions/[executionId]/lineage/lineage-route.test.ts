import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const body = {
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
	};
	type GetLineageResult =
		| { status: "ok"; body: typeof body }
		| { status: "error"; httpStatus: number; message: string };
	const workflowExecutionLineage = {
		getLineage: vi.fn(
			async (): Promise<GetLineageResult> => ({ status: "ok", body }),
		),
	};
	return { body, workflowExecutionLineage };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowExecutionLineage: mocks.workflowExecutionLineage,
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

describe("workflow execution lineage route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowExecutionLineage.getLineage.mockResolvedValue({
			status: "ok",
			body: mocks.body,
		});
	});

	it("keeps the UI-facing route behind workflow execution lineage application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionLineage.getLineage");
		expect(source).not.toContain("workflowData");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns lineage from the application service", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			rootId: "root-exec",
			currentId: "exec-1",
			nodes: [{ id: "root-exec" }, { id: "exec-1", isCurrent: true }],
		});
		expect(mocks.workflowExecutionLineage.getLineage).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("does not load lineage outside the active workspace", async () => {
		mocks.workflowExecutionLineage.getLineage.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});
