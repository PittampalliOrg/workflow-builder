import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requireInternal: vi.fn(),
	workflowData: {
		getBenchmarkRunInstanceProgress: vi.fn(),
	},
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: mocks.workflowData,
	}),
}));

import { GET } from "./[runId]/instances/[instanceId]/progress/+server";

describe("internal benchmark run-instance progress route", () => {
	beforeEach(() => {
		mocks.requireInternal.mockReset();
		mocks.workflowData.getBenchmarkRunInstanceProgress.mockReset();
	});

	it("loads progress through workflow-data", async () => {
		const latestActivityAt = new Date("2026-07-03T14:00:00.000Z");
		mocks.workflowData.getBenchmarkRunInstanceProgress.mockResolvedValue({
			status: "ok",
			runInstanceStatus: "running",
			inferenceStatus: "running",
			evaluationStatus: "pending",
			sessionId: "session-1",
			latestSessionEventType: "agent.llm_usage",
			latestSessionEventSequence: 42,
			latestActivityAt,
			activityAgeSeconds: 12,
			progressMarker: "running:running:pending:marker",
		});

		const response = (await GET({
			request: new Request("http://localhost"),
			params: { runId: "run-1", instanceId: "sympy__sympy-20590" },
		} as never)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.requireInternal).toHaveBeenCalledTimes(1);
		expect(mocks.workflowData.getBenchmarkRunInstanceProgress).toHaveBeenCalledWith({
			runId: "run-1",
			instanceId: "sympy__sympy-20590",
		});
		expect(body).toEqual({
			status: "running",
			inferenceStatus: "running",
			evaluationStatus: "pending",
			sessionId: "session-1",
			latestSessionEventType: "agent.llm_usage",
			latestSessionEventSequence: 42,
			latestActivityAt: latestActivityAt.toISOString(),
			activityAgeSeconds: 12,
			progressMarker: "running:running:pending:marker",
		});
	});

	it("keeps the progress route free of direct DB imports", () => {
		const source = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"[runId]/instances/[instanceId]/progress/+server.ts",
			),
			"utf8",
		);

		expect(source).toContain("getBenchmarkRunInstanceProgress");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});
