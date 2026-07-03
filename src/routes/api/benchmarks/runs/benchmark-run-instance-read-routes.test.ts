import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workflowDataMock = vi.hoisted(() => ({
	getBenchmarkRunInstanceDetail: vi.fn(),
	listBenchmarkRunInstanceScores: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: workflowDataMock,
	}),
}));

import { GET as getRunInstanceDetail } from "./[runId]/instances/[instanceId]/+server";
import { GET as getScores } from "./[runId]/instances/[instanceId]/scores/+server";

describe("benchmark run-instance read routes", () => {
	beforeEach(() => {
		workflowDataMock.getBenchmarkRunInstanceDetail.mockReset();
		workflowDataMock.listBenchmarkRunInstanceScores.mockReset();
	});

	it("loads run-instance detail through workflow-data", async () => {
		workflowDataMock.getBenchmarkRunInstanceDetail.mockResolvedValue({
			status: "ok",
			mlflowExperimentId: "exp-1",
			runInstance: {
				id: "run-inst-1",
				runId: "run-1",
				instanceId: "sympy__sympy-20590",
				evaluationStatus: "resolved",
				evaluatedAt: new Date("2026-07-03T12:00:00.000Z"),
				harnessResult: { resolved: true },
				mlflowRunId: "mlflow-run-1",
				traceIds: ["trace-1"],
			},
			instance: {
				repo: "sympy/sympy",
				baseCommit: "abc123",
				problemStatement: "Fix it",
				hintsText: "Look at Add",
				testMetadata: {
					version: "1.7",
					test_patch: "diff --git a/sympy/tests/test_add.py b/sympy/tests/test_add.py\n",
					FAIL_TO_PASS: ["sympy/tests/test_add.py::test_regression"],
				},
				metadata: { issue_url: "https://example.test/issue" },
				goldPatch: "diff --git a/sympy/core/add.py b/sympy/core/add.py\n",
			},
			executionIr: { jobName: "bench-host-1" },
			executionOutput: null,
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
		expect(workflowDataMock.getBenchmarkRunInstanceDetail).toHaveBeenCalledWith({
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

		expect(detailSource).toContain("getBenchmarkRunInstanceDetail");
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
