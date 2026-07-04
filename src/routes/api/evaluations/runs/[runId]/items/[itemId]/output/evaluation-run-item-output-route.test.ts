import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	evaluationRunItems: {
		updatePublicOutput: vi.fn(async () => ({
			item: { id: "item-1" },
			run: { id: "run-1" },
		})),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		evaluationRunItems: mocks.evaluationRunItems,
	}),
}));

import { POST } from "./+server";

describe("/api/evaluations/runs/[runId]/items/[itemId]/output route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps public output updates behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("evaluationRunItems.updatePublicOutput");
		expect(source).not.toContain("$lib/server/evaluations/service");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates output updates", async () => {
		const body = { output: { answer: 42 } };
		const response = await POST({
			request: new Request(
				"http://localhost/api/evaluations/runs/run-1/items/item-1/output",
				{
					method: "POST",
					body: JSON.stringify(body),
				},
			),
			params: { runId: "run-1", itemId: "item-1" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			item: { id: "item-1" },
			run: { id: "run-1" },
		});
		expect(mocks.evaluationRunItems.updatePublicOutput).toHaveBeenCalledWith({
			projectId: "project-1",
			runId: "run-1",
			itemId: "item-1",
			body,
		});
	});
});
