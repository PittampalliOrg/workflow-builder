import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const execution = {
		id: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		status: "running",
	};
	const rows = [
		{
			modelSpec: "openai/gpt-4.1-mini",
			inputTokens: 100,
			outputTokens: 40,
			cacheReadTokens: 20,
			cacheCreateTokens: 10,
		},
	];
	const workflowData = {
		getScopedExecutionById: vi.fn(async (): Promise<typeof execution | null> => execution),
		aggregateExecutionUsageMetrics: vi.fn(async () => rows),
	};
	const costFor = vi.fn(() => 0.1234);
	const formatCurrency = vi.fn(() => "$0.1234");
	return { execution, rows, workflowData, costFor, formatCurrency };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/pricing/model-pricing", () => ({
	costFor: mocks.costFor,
	formatCurrency: mocks.formatCurrency,
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1" },
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		...overrides,
	};
}

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
	try {
		const result = await promise;
		expect((result as { status?: number }).status).toBe(status);
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
	}
}

describe("workflow execution metrics route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getScopedExecutionById.mockResolvedValue(mocks.execution);
		mocks.workflowData.aggregateExecutionUsageMetrics.mockResolvedValue(mocks.rows);
		mocks.costFor.mockReturnValue(0.1234);
		mocks.formatCurrency.mockReturnValue("$0.1234");
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getScopedExecutionById");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns aggregate usage metrics from workflow-data", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			totals: {
				inputTokens: 100,
				outputTokens: 40,
				cacheReadTokens: 20,
				cacheCreateTokens: 10,
				totalTokens: 170,
			},
			cacheHitPct: 17,
			totalCost: 0.1234,
			totalCostLabel: "$0.1234",
			byModel: [
				{
					model: "openai/gpt-4.1-mini",
					inputTokens: 100,
					outputTokens: 40,
					cacheReadTokens: 20,
					cacheCreateTokens: 10,
					cost: 0.1234,
				},
			],
		});
		expect(mocks.workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(mocks.workflowData.aggregateExecutionUsageMetrics).toHaveBeenCalledWith({
			executionId: "exec-1",
			projectId: "project-1",
			includeAncestors: true,
		});
	});

	it("hides executions outside the active workspace", async () => {
		mocks.workflowData.getScopedExecutionById.mockResolvedValueOnce(null);

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.workflowData.aggregateExecutionUsageMetrics).not.toHaveBeenCalled();
	});
});
