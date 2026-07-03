import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workflowDataMock = vi.hoisted(() => ({
	listBenchmarkRunInstanceScores: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: workflowDataMock,
	}),
}));

import { GET as getScores } from "./[runId]/instances/[instanceId]/scores/+server";

describe("benchmark run-instance read routes", () => {
	beforeEach(() => {
		workflowDataMock.listBenchmarkRunInstanceScores.mockReset();
	});

	it("loads scorer rows through workflow-data", async () => {
		const createdAt = new Date("2026-07-03T12:00:00.000Z");
		workflowDataMock.listBenchmarkRunInstanceScores.mockResolvedValue({
			status: "ok",
			scores: [
				{
					id: "score-1",
					scorerName: "reasoning_quality",
					scorerVersion: 1,
					score: 0.9,
					reasoning: "Clear reasoning",
					metadata: { model: "judge" },
					createdAt,
				},
			],
		});

		const response = (await getScores({
			params: { runId: "run-1", instanceId: "sympy__sympy-20590" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({
			scores: [
				{
					id: "score-1",
					scorerName: "reasoning_quality",
					scorerVersion: 1,
					score: 0.9,
					reasoning: "Clear reasoning",
					metadata: { model: "judge" },
					createdAt: createdAt.toISOString(),
				},
			],
		});
		expect(workflowDataMock.listBenchmarkRunInstanceScores).toHaveBeenCalledWith({
			runId: "run-1",
			instanceId: "sympy__sympy-20590",
			projectId: "project-1",
		});
	});

	it("keeps benchmark run-instance read routes free of direct route DB imports", () => {
		const dir = dirname(fileURLToPath(import.meta.url));
		const scoresSource = readFileSync(
			join(dir, "[runId]/instances/[instanceId]/scores/+server.ts"),
			"utf8",
		);
		const spansSource = readFileSync(
			join(dir, "[runId]/instances/[instanceId]/spans/+server.ts"),
			"utf8",
		);

		expect(scoresSource).toContain("listBenchmarkRunInstanceScores");
		expect(scoresSource).not.toContain("$lib/server/db");
		expect(scoresSource).not.toContain("$lib/server/db/schema");
		expect(scoresSource).not.toContain("drizzle-orm");
		expect(spansSource).not.toContain("$lib/server/db");
		expect(spansSource).not.toContain("$lib/server/db/schema");
		expect(spansSource).not.toContain("drizzle-orm");
	});
});
