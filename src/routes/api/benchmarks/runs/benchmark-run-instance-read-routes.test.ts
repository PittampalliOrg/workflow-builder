import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workflowDataMock = vi.hoisted(() => ({
	getBenchmarkRunInstanceDetail: vi.fn(),
	listBenchmarkRunInstanceScores: vi.fn(),
}));
const benchmarkRunInstanceDetailMock = vi.hoisted(() => ({
	getDetail: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		benchmarkRunInstanceDetail: benchmarkRunInstanceDetailMock,
		workflowData: workflowDataMock,
	}),
}));

import { GET as getRunInstanceDetail } from "./[runId]/instances/[instanceId]/+server";
import { GET as getScores } from "./[runId]/instances/[instanceId]/scores/+server";

describe("benchmark run-instance read routes", () => {
	beforeEach(() => {
		benchmarkRunInstanceDetailMock.getDetail.mockReset();
		workflowDataMock.getBenchmarkRunInstanceDetail.mockReset();
		workflowDataMock.listBenchmarkRunInstanceScores.mockReset();
	});

	it("loads run-instance detail through the application service", async () => {
		benchmarkRunInstanceDetailMock.getDetail.mockResolvedValue({
			status: "ok",
			body: {
				runInstance: {
					id: "run-inst-1",
					hostJobName: "bench-host-1",
				},
				instance: {
					testMetadata: { version: "1.7" },
				},
				goldPatch: "diff --git a/sympy/core/add.py b/sympy/core/add.py\n",
			},
		});

		const response = (await getRunInstanceDetail({
			params: { runId: "run-1", instanceId: "sympy__sympy-20590" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.runInstance.hostJobName).toBe("bench-host-1");
		expect(body.instance.testMetadata).toEqual({ version: "1.7" });
		expect(body.goldPatch).toBe("diff --git a/sympy/core/add.py b/sympy/core/add.py\n");
		expect(JSON.stringify(body.instance.testMetadata)).not.toContain("test_patch");
		expect(benchmarkRunInstanceDetailMock.getDetail).toHaveBeenCalledWith({
			runId: "run-1",
			instanceId: "sympy__sympy-20590",
			projectId: "project-1",
		});
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
		const detailSource = readFileSync(
			join(dir, "[runId]/instances/[instanceId]/+server.ts"),
			"utf8",
		);
		const scoresSource = readFileSync(
			join(dir, "[runId]/instances/[instanceId]/scores/+server.ts"),
			"utf8",
		);
		const spansSource = readFileSync(
			join(dir, "[runId]/instances/[instanceId]/spans/+server.ts"),
			"utf8",
		);

		expect(detailSource).toContain("benchmarkRunInstanceDetail.getDetail");
		expect(detailSource).not.toContain("$lib/server/benchmarks/mlflow");
		expect(detailSource).not.toContain("$lib/server/benchmarks/harness-result");
		expect(detailSource).not.toContain("$lib/server/benchmarks/patch-compare");
		expect(detailSource).not.toContain("$lib/server/benchmarks/contamination");
		expect(detailSource).not.toContain("$lib/server/db");
		expect(detailSource).not.toContain("$lib/server/db/schema");
		expect(detailSource).not.toContain("drizzle-orm");
		expect(scoresSource).toContain("listBenchmarkRunInstanceScores");
		expect(scoresSource).not.toContain("$lib/server/db");
		expect(scoresSource).not.toContain("$lib/server/db/schema");
		expect(scoresSource).not.toContain("drizzle-orm");
		expect(spansSource).not.toContain("$lib/server/db");
		expect(spansSource).not.toContain("$lib/server/db/schema");
		expect(spansSource).not.toContain("drizzle-orm");
	});
});
