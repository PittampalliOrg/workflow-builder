import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowCodeCheckpoints = {
		restoreCheckpoint: vi.fn(async () => ({
			checkpoint: { id: "checkpoint-1" },
			sandboxName: "sandbox-1",
			repoPath: "/repo",
		}) as unknown),
	};
	return { workflowCodeCheckpoints };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowCodeCheckpoints: mocks.workflowCodeCheckpoints,
	}),
}));

import { POST } from "./+server";

describe("workflow code checkpoint restore route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowCodeCheckpoints.restoreCheckpoint.mockResolvedValue({
			checkpoint: { id: "checkpoint-1" },
			sandboxName: "sandbox-1",
			repoPath: "/repo",
		});
	});

	it("delegates checkpoint restores to the application service", async () => {
		const response = (await POST(event())) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			checkpoint: { id: "checkpoint-1" },
			sandboxName: "sandbox-1",
			repoPath: "/repo",
		});
		expect(mocks.workflowCodeCheckpoints.restoreCheckpoint).toHaveBeenCalledWith({
			executionId: "exec-1",
			checkpointId: "checkpoint-1",
			sandboxName: "sandbox-1",
			repoPath: "/repo",
		});
	});

	it("preserves helper error status mapping", async () => {
		mocks.workflowCodeCheckpoints.restoreCheckpoint.mockResolvedValueOnce({
			error: "sandboxName is required",
			status: 400,
		});

		const response = (await POST(event({ body: {} }))) as Response;

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			message: "sandboxName is required",
		});
	});

	it("keeps direct checkpoint infrastructure helpers out of the route", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowCodeCheckpoints.restoreCheckpoint");
		expect(source).not.toContain("$lib/server/workflows/code-checkpoints");
		expect(source).not.toContain("restoreCodeCheckpointToSandbox");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("openshellRuntimeFetch");
		expect(source).not.toContain("daprFetch");
		expect(source).not.toContain("execFile");
	});
});

function event(options: { body?: Record<string, unknown> } = {}) {
	return {
		params: { executionId: "exec-1", checkpointId: "checkpoint-1" },
		request: new Request("http://localhost", {
			method: "POST",
			body: JSON.stringify(options.body ?? { sandboxName: "sandbox-1", repoPath: "/repo" }),
		}),
	} as never;
}
