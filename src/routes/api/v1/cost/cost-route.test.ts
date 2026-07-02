import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		getCostBreakdown: vi.fn(async () => ({
			range: {
				start: "2026-07-01T00:00:00.000Z",
				end: "2026-07-02T00:00:00.000Z",
			},
			totalCost: 1.25,
			priceBook: [],
			byAgent: [],
			byModel: [],
		})),
	};
	return { workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

function event() {
	return {
		url: new URL(
			"http://localhost/api/v1/cost?start=2026-07-01T00:00:00.000Z&end=2026-07-02T00:00:00.000Z&api_key=ignored",
		),
		locals: { session: { userId: "user-1", projectId: "project-1" } },
	};
}

describe("cost route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps cost reporting behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.getCostBreakdown");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});

	it("passes authenticated scope and range query params to workflow-data", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			totalCost: 1.25,
			range: {
				start: "2026-07-01T00:00:00.000Z",
				end: "2026-07-02T00:00:00.000Z",
			},
		});
		expect(mocks.workflowData.getCostBreakdown).toHaveBeenCalledWith({
			userId: "user-1",
			projectId: "project-1",
			start: "2026-07-01T00:00:00.000Z",
			end: "2026-07-02T00:00:00.000Z",
		});
	});
});
