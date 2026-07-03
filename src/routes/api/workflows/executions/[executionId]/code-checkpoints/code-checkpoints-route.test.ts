import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowCodeCheckpoints = {
		listForExecution: vi.fn(async () => [
			{ id: "checkpoint-1", workflowExecutionId: "exec-1" },
		]),
	};
	return { workflowCodeCheckpoints };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowCodeCheckpoints: mocks.workflowCodeCheckpoints,
	}),
}));

import { GET } from "./+server";

describe("workflow code checkpoints route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowCodeCheckpoints.listForExecution.mockResolvedValue([
			{ id: "checkpoint-1", workflowExecutionId: "exec-1" },
		]);
	});

	it("delegates checkpoint listing to the application service", async () => {
		const response = (await GET(event())) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			checkpoints: [{ id: "checkpoint-1", workflowExecutionId: "exec-1" }],
		});
		expect(mocks.workflowCodeCheckpoints.listForExecution).toHaveBeenCalledWith({
			executionId: "exec-1",
		});
	});

	it("preserves the generic 500 error mapping", async () => {
		mocks.workflowCodeCheckpoints.listForExecution.mockRejectedValueOnce(
			new Error("boom"),
		);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
			/* quiet expected route log */
		});

		const response = (await GET(event())) as Response;

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			message: "Failed to load code checkpoints",
		});
		consoleError.mockRestore();
	});

	it("keeps direct checkpoint infrastructure helpers out of the route", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowCodeCheckpoints.listForExecution");
		expect(source).not.toContain("$lib/server/workflows/code-checkpoints");
		expect(source).not.toContain("listCodeCheckpointsForExecution");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("openshellRuntimeFetch");
		expect(source).not.toContain("daprFetch");
	});
});

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1" },
		...overrides,
	} as never;
}
