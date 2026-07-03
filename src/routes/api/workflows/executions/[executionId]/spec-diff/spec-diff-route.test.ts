import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const body = {
		hasParent: true,
		parentId: "exec-parent",
		fromNode: "refine",
		snapshotUnavailable: false,
		added: ["verify"],
		removed: [],
		changed: [{ name: "refine", patch: "--- refine (parent)\n+++ refine (this run)\n" }],
	};
	type GetSpecDiffResult =
		| { status: "ok"; body: typeof body }
		| { status: "error"; httpStatus: number; message: string };
	const workflowExecutionSpecDiff = {
		getSpecDiff: vi.fn(
			async (): Promise<GetSpecDiffResult> => ({ status: "ok", body }),
		),
	};
	return { body, workflowExecutionSpecDiff };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowExecutionSpecDiff: mocks.workflowExecutionSpecDiff,
	}),
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
		mocks.workflowExecutionSpecDiff.getSpecDiff.mockResolvedValue({
			status: "ok",
			body: mocks.body,
		});
	});

	it("keeps the route behind workflow execution spec-diff application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionSpecDiff.getSpecDiff");
		expect(source).not.toContain("workflowData");
		expect(source).not.toContain("createTwoFilesPatch");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
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
		expect(mocks.workflowExecutionSpecDiff.getSpecDiff).toHaveBeenCalledWith({
			executionId: "exec-child",
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("hides executions outside the active workspace", async () => {
		mocks.workflowExecutionSpecDiff.getSpecDiff.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});
