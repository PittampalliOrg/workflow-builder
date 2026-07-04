import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	evaluationRunItems: {
		get: vi.fn(async () => ({ item: { id: "item-1" } })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		evaluationRunItems: mocks.evaluationRunItems,
	}),
}));

import { GET } from "./+server";

describe("/api/evaluations/runs/[runId]/items/[itemId] route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps run item reads behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("evaluationRunItems.get");
		expect(source).not.toContain("$lib/server/evaluations/service");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates scoped item reads", async () => {
		const response = await GET({
			params: { runId: "run-1", itemId: "item-1" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			item: { id: "item-1" },
		});
		expect(mocks.evaluationRunItems.get).toHaveBeenCalledWith({
			projectId: "project-1",
			runId: "run-1",
			itemId: "item-1",
		});
	});
});
