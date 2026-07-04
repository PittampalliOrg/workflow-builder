import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requireInternal: vi.fn(),
	evaluationRuns: {
		getInternalStatus: vi.fn(),
		markStatus: vi.fn(),
	},
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		evaluationRuns: mocks.evaluationRuns,
	}),
}));

import { GET, POST } from "./[runId]/status/+server";

describe("internal evaluation run status route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.evaluationRuns.getInternalStatus.mockResolvedValue({
			run: {
				id: "eval-run-1",
				status: "running",
			},
		});
		mocks.evaluationRuns.markStatus.mockResolvedValue({
			success: true,
			run: {
				id: "eval-run-1",
				status: "grading",
			},
		});
	});

	it("loads run status through the application service", async () => {
		const response = (await GET({
			request: new Request("http://localhost"),
			params: { runId: "eval-run-1" },
		} as never)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.requireInternal).toHaveBeenCalledTimes(1);
		expect(mocks.evaluationRuns.getInternalStatus).toHaveBeenCalledWith({
			runId: "eval-run-1",
		});
		expect(body).toEqual({
			run: {
				id: "eval-run-1",
				status: "running",
			},
		});
	});

	it("updates status through the application service", async () => {
		const requestBody = {
			status: "grading",
			coordinatorExecutionId: "coord-1",
			usage: { inputTokens: 12 },
		};
		const response = (await POST({
			request: new Request("http://localhost", {
				method: "POST",
				body: JSON.stringify(requestBody),
			}),
			params: { runId: "eval-run-1" },
		} as never)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.evaluationRuns.markStatus).toHaveBeenCalledWith({
			runId: "eval-run-1",
			body: requestBody,
		});
		expect(body).toEqual({
			success: true,
			run: {
				id: "eval-run-1",
				status: "grading",
			},
		});
	});

	it("keeps the route free of direct DB imports", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "[runId]/status/+server.ts"),
			"utf8",
		);

		expect(source).toContain("evaluationRuns.getInternalStatus");
		expect(source).toContain("evaluationRuns.markStatus");
		expect(source).not.toContain("$lib/server/evaluations/service");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});

	it("keeps migrated item and artifact routes free of direct DB imports", () => {
		for (const relativePath of [
			"[runId]/items/[itemId]/status/+server.ts",
			"[runId]/items/[itemId]/grader-results/+server.ts",
			"[runId]/artifacts/+server.ts",
		]) {
			const source = readFileSync(
				join(dirname(fileURLToPath(import.meta.url)), relativePath),
				"utf8",
			);

			expect(source).toContain("$lib/server/application");
			expect(source).not.toContain("$lib/server/evaluations/service");
			expect(source).not.toContain("$lib/server/db");
			expect(source).not.toContain("$lib/server/db/schema");
			expect(source).not.toContain("drizzle-orm");
		}
	});
});
