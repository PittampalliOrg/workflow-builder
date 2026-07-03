import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowCodeCheckpoints = {
		diffCheckpoint: vi.fn(async () => ({
			checkpoint: { id: "checkpoint-1" },
			diff: "diff --git a/src/app.ts b/src/app.ts",
			exitCode: 0,
		}) as unknown),
	};
	return { workflowCodeCheckpoints };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowCodeCheckpoints: mocks.workflowCodeCheckpoints,
	}),
}));

import { GET } from "./+server";

describe("workflow code checkpoint diff route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowCodeCheckpoints.diffCheckpoint.mockResolvedValue({
			checkpoint: { id: "checkpoint-1" },
			diff: "diff --git a/src/app.ts b/src/app.ts",
			exitCode: 0,
		});
	});

	it("delegates checkpoint diff loading to the application service", async () => {
		const response = (await GET(event())) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			checkpoint: { id: "checkpoint-1" },
			diff: "diff --git a/src/app.ts b/src/app.ts",
			exitCode: 0,
		});
		expect(mocks.workflowCodeCheckpoints.diffCheckpoint).toHaveBeenCalledWith({
			executionId: "exec-1",
			checkpointId: "checkpoint-1",
			path: "src/app.ts",
		});
	});

	it("preserves helper error status mapping", async () => {
		mocks.workflowCodeCheckpoints.diffCheckpoint.mockResolvedValueOnce({
			error: "Invalid file path",
			status: 400,
		});

		const response = (await GET(event())) as Response;

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			message: "Invalid file path",
		});
	});

	it("keeps direct checkpoint infrastructure helpers out of the route", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowCodeCheckpoints.diffCheckpoint");
		expect(source).not.toContain("$lib/server/workflows/code-checkpoints");
		expect(source).not.toContain("loadCodeCheckpointDiff");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("openshellRuntimeFetch");
		expect(source).not.toContain("daprFetch");
		expect(source).not.toContain("execFile");
	});
});

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1", checkpointId: "checkpoint-1" },
		url: new URL(
			"http://localhost/api/workflows/executions/exec-1/code-checkpoints/checkpoint-1/diff?path=src/app.ts",
		),
		...overrides,
	} as never;
}
