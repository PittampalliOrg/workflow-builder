import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		getUsageAnalytics: vi.fn(async () => ({
			range: {
				start: "2026-07-01T00:00:00.000Z",
				end: "2026-07-02T00:00:00.000Z",
			},
			groupBy: "day",
			totals: {
				tokensIn: 100,
				tokensOut: 25,
				cacheReadTokens: 0,
				cacheCreateTokens: 0,
				sessionCount: 1,
				toolCalls: 2,
			},
			daily: [],
			byAgent: [],
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
			"http://localhost/api/v1/usage?start=2026-07-01T00:00:00.000Z&end=2026-07-02T00:00:00.000Z&groupBy=agent",
		),
		locals: { session: { userId: "user-1", projectId: "project-1" } },
	};
}

describe("usage route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps usage reporting behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.getUsageAnalytics");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});

	it("passes authenticated scope and range query params to workflow-data", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			range: {
				start: "2026-07-01T00:00:00.000Z",
				end: "2026-07-02T00:00:00.000Z",
			},
			groupBy: "day",
		});
		expect(mocks.workflowData.getUsageAnalytics).toHaveBeenCalledWith({
			userId: "user-1",
			projectId: "project-1",
			start: "2026-07-01T00:00:00.000Z",
			end: "2026-07-02T00:00:00.000Z",
			groupBy: "agent",
		});
	});
});
