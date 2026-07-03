import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowExecutionMetricsService } from "$lib/server/application/workflow-execution-metrics";

describe("ApplicationWorkflowExecutionMetricsService", () => {
	let workflowData: ConstructorParameters<
		typeof ApplicationWorkflowExecutionMetricsService
	>[0]["workflowData"];
	let pricing: ConstructorParameters<
		typeof ApplicationWorkflowExecutionMetricsService
	>[0]["pricing"];
	let service: ApplicationWorkflowExecutionMetricsService;

	beforeEach(() => {
		workflowData = {
			getScopedExecutionById: vi.fn(async () => ({ id: "exec-1" }) as never),
			aggregateExecutionUsageMetrics: vi.fn(async () => rows()),
		};
		pricing = {
			costFor: vi.fn((modelSpec: string | null) =>
				modelSpec === "openai/gpt-4.1-mini" ? 0.1234 : 0.01,
			),
			formatCurrency: vi.fn(() => "$0.1334"),
		};
		service = new ApplicationWorkflowExecutionMetricsService({
			workflowData,
			pricing,
		});
	});

	it("builds aggregate usage metrics after scoped execution access", async () => {
		await expect(
			service.getMetrics({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "ok",
			body: {
				totals: {
					inputTokens: 100,
					outputTokens: 45,
					cacheReadTokens: 20,
					cacheCreateTokens: 10,
					totalTokens: 175,
				},
				cacheHitPct: 17,
				totalCost: 0.1334,
				totalCostLabel: "$0.1334",
				byModel: [
					{
						model: "openai/gpt-4.1-mini",
						inputTokens: 100,
						outputTokens: 40,
						cacheReadTokens: 20,
						cacheCreateTokens: 10,
						cost: 0.1234,
					},
					{
						model: "unknown",
						inputTokens: 0,
						outputTokens: 5,
						cacheReadTokens: 0,
						cacheCreateTokens: 0,
						cost: 0.01,
					},
				],
			},
		});
		expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(workflowData.aggregateExecutionUsageMetrics).toHaveBeenCalledWith({
			executionId: "exec-1",
			projectId: "project-1",
			includeAncestors: true,
		});
		expect(pricing.formatCurrency).toHaveBeenCalledWith(0.1334);
	});

	it("hides missing or out-of-scope executions before aggregation", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(null);

		await expect(
			service.getMetrics({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
		expect(workflowData.aggregateExecutionUsageMetrics).not.toHaveBeenCalled();
	});

	it("returns zero totals and null cache hit percentage when no usage exists", async () => {
		vi.mocked(workflowData.aggregateExecutionUsageMetrics).mockResolvedValueOnce(
			[],
		);
		vi.mocked(pricing.formatCurrency).mockReturnValueOnce("$0.0000");

		await expect(
			service.getMetrics({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "ok",
			body: {
				totals: {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheCreateTokens: 0,
					totalTokens: 0,
				},
				cacheHitPct: null,
				totalCost: 0,
				totalCostLabel: "$0.0000",
				byModel: [],
			},
		});
	});
});

function rows() {
	return [
		{
			modelSpec: "openai/gpt-4.1-mini",
			inputTokens: 100,
			outputTokens: 40,
			cacheReadTokens: 20,
			cacheCreateTokens: 10,
		},
		{
			modelSpec: null,
			inputTokens: 0,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheCreateTokens: 0,
		},
	];
}
