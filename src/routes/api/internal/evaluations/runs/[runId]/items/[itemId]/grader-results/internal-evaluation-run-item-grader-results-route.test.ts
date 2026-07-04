import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	evaluationRunItems: {
		recordGraderResults: vi.fn(async () => ({
			success: true,
			item: { id: "item-1" },
		})),
	},
	requireInternal: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		evaluationRunItems: mocks.evaluationRunItems,
	}),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

import { POST } from "./+server";

describe("/api/internal/evaluations/runs/[runId]/items/[itemId]/grader-results route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps grader-result callbacks behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("evaluationRunItems.recordGraderResults");
		expect(source).not.toContain("$lib/server/evaluations/service");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates grader-result callbacks", async () => {
		const body = { graderResults: { correctness: { passed: true } } };
		const request = new Request(
			"http://localhost/api/internal/evaluations/runs/run-1/items/item-1/grader-results",
			{ method: "POST", body: JSON.stringify(body) },
		);
		const response = await POST({
			request,
			params: { runId: "run-1", itemId: "item-1" },
		} as never);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			success: true,
			item: { id: "item-1" },
		});
		expect(mocks.requireInternal).toHaveBeenCalledWith(request);
		expect(mocks.evaluationRunItems.recordGraderResults).toHaveBeenCalledWith({
			runId: "run-1",
			itemId: "item-1",
			body,
		});
	});
});
