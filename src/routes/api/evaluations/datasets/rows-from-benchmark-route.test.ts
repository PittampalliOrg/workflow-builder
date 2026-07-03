import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workflowDataMock = vi.hoisted(() => ({
	promoteBenchmarkRunInstanceToDataset: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: workflowDataMock,
	}),
}));

import { POST } from "./[datasetId]/rows-from-benchmark/+server";

describe("evaluation dataset rows-from-benchmark route", () => {
	beforeEach(() => {
		workflowDataMock.promoteBenchmarkRunInstanceToDataset.mockReset();
	});

	it("promotes a benchmark run instance through workflow-data", async () => {
		const createdAt = new Date("2026-07-03T13:00:01.000Z");
		const updatedAt = new Date("2026-07-03T13:00:02.000Z");
		workflowDataMock.promoteBenchmarkRunInstanceToDataset.mockResolvedValue({
			status: "ok",
			rows: [
				{
					id: "dataset-row-1",
					datasetId: "dataset-1",
					externalId: "sympy__sympy-20590",
					input: { instance_id: "sympy__sympy-20590" },
					expectedOutput: { harness_resolved: true },
					generatedOutput: null,
					annotations: {},
					rating: null,
					feedback: null,
					metadata: { promotedFromRunId: "run-1" },
					originRunInstanceId: "run-instance-1",
					originSessionId: "session-1",
					createdAt,
					updatedAt,
				},
			],
		});

		const response = (await POST({
			request: new Request("http://localhost", {
				method: "POST",
				body: JSON.stringify({
					runId: "run-1",
					instanceId: "sympy__sympy-20590",
				}),
			}),
			params: { datasetId: "dataset-1" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never)) as Response;
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(body.rows).toEqual([
			{
				id: "dataset-row-1",
				datasetId: "dataset-1",
				externalId: "sympy__sympy-20590",
				input: { instance_id: "sympy__sympy-20590" },
				expectedOutput: { harness_resolved: true },
				generatedOutput: null,
				annotations: {},
				rating: null,
				feedback: null,
				metadata: { promotedFromRunId: "run-1" },
				originRunInstanceId: "run-instance-1",
				originSessionId: "session-1",
				createdAt: createdAt.toISOString(),
				updatedAt: updatedAt.toISOString(),
			},
		]);
		expect(workflowDataMock.promoteBenchmarkRunInstanceToDataset).toHaveBeenCalledWith({
			projectId: "project-1",
			datasetId: "dataset-1",
			runId: "run-1",
			instanceId: "sympy__sympy-20590",
		});
	});

	it("keeps the route free of direct DB imports", () => {
		const source = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"[datasetId]/rows-from-benchmark/+server.ts",
			),
			"utf8",
		);

		expect(source).toContain("promoteBenchmarkRunInstanceToDataset");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/evaluations/service");
	});
});
