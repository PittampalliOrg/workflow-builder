import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const body = {
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
	};
	type GetMetricsResult =
		| { status: "ok"; body: typeof body }
		| { status: "error"; httpStatus: number; message: string };
	const workflowExecutionMetrics = {
		getMetrics: vi.fn(async (): Promise<GetMetricsResult> => ({ status: "ok", body })),
	};
	return { body, workflowExecutionMetrics };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowExecutionMetrics: mocks.workflowExecutionMetrics,
	}),
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
		mocks.workflowExecutionMetrics.getMetrics.mockResolvedValue({
			status: "ok",
			body: mocks.body,
		});
	});

	it("keeps the route behind workflow execution metrics application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionMetrics.getMetrics");
		expect(source).not.toContain("workflowData");
		expect(source).not.toContain("$lib/server/pricing/model-pricing");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns aggregate usage metrics from the application service", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual(mocks.body);
		expect(mocks.workflowExecutionMetrics.getMetrics).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("hides executions outside the active workspace", async () => {
		mocks.workflowExecutionMetrics.getMetrics.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});
