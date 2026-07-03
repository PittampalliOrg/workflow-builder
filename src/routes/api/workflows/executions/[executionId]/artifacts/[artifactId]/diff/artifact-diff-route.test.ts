import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const body = {
		patch: "diff --git a/a b/a\n",
		baseRef: null,
		headRef: null,
		stats: { files: 1, additions: 1, deletions: 0 },
		truncated: false,
	};
	type GetDiffResult =
		| { status: "ok"; body: typeof body }
		| { status: "error"; httpStatus: number; message: string };
	const workflowExecutionArtifactDiff = {
		getDiff: vi.fn(async (): Promise<GetDiffResult> => ({ status: "ok", body })),
	};
	return { body, workflowExecutionArtifactDiff };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowExecutionArtifactDiff: mocks.workflowExecutionArtifactDiff,
	}),
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1", artifactId: "artifact-1" },
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

describe("workflow execution artifact diff route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowExecutionArtifactDiff.getDiff.mockResolvedValue({
			status: "ok",
			body: mocks.body,
		});
	});

	it("keeps the route behind workflow execution artifact diff application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionArtifactDiff.getDiff");
		expect(source).not.toContain("workflowData");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/workflows/run-diff");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns the resolved diff artifact", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual(mocks.body);
		expect(mocks.workflowExecutionArtifactDiff.getDiff).toHaveBeenCalledWith({
			executionId: "exec-1",
			artifactId: "artifact-1",
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("hides executions outside the active workspace before loading artifact data", async () => {
		mocks.workflowExecutionArtifactDiff.getDiff.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});

	it("rejects non-diff artifacts", async () => {
		mocks.workflowExecutionArtifactDiff.getDiff.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Diff artifact not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});
