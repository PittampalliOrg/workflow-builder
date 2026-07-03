import type {
	WorkflowDataService,
	WorkflowExecutionUsageMetricsRow,
} from "$lib/server/application/ports";

export type WorkflowExecutionMetricsInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
};

export type WorkflowExecutionMetricsUsage = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreateTokens: number;
};

export type WorkflowExecutionMetricsModel = WorkflowExecutionMetricsUsage & {
	model: string;
	cost: number;
};

export type WorkflowExecutionMetricsBody = {
	totals: WorkflowExecutionMetricsUsage & { totalTokens: number };
	cacheHitPct: number | null;
	totalCost: number;
	totalCostLabel: string;
	byModel: WorkflowExecutionMetricsModel[];
};

export type WorkflowExecutionMetricsResult =
	| { status: "ok"; body: WorkflowExecutionMetricsBody }
	| { status: "error"; httpStatus: number; message: string };

export type WorkflowExecutionMetricsPricingPort = {
	costFor(modelSpec: string | null, usage: WorkflowExecutionMetricsUsage): number;
	formatCurrency(cost: number): string;
};

export class ApplicationWorkflowExecutionMetricsService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				"getScopedExecutionById" | "aggregateExecutionUsageMetrics"
			>;
			pricing: WorkflowExecutionMetricsPricingPort;
		},
	) {}

	async getMetrics(
		input: WorkflowExecutionMetricsInput,
	): Promise<WorkflowExecutionMetricsResult> {
		const execution = await this.deps.workflowData.getScopedExecutionById({
			executionId: input.executionId,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
		if (!execution) {
			return {
				status: "error",
				httpStatus: 404,
				message: "Execution not found",
			};
		}

		const rows = await this.deps.workflowData.aggregateExecutionUsageMetrics({
			executionId: input.executionId,
			projectId: input.projectId ?? null,
			includeAncestors: true,
		});

		return { status: "ok", body: this.buildBody(rows) };
	}

	private buildBody(
		rows: WorkflowExecutionUsageMetricsRow[],
	): WorkflowExecutionMetricsBody {
		const totals: WorkflowExecutionMetricsUsage = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreateTokens: 0,
		};
		let totalCost = 0;
		const byModel: WorkflowExecutionMetricsModel[] = [];

		for (const row of rows) {
			const usage: WorkflowExecutionMetricsUsage = {
				inputTokens: row.inputTokens,
				outputTokens: row.outputTokens,
				cacheReadTokens: row.cacheReadTokens,
				cacheCreateTokens: row.cacheCreateTokens,
			};
			const cost = this.deps.pricing.costFor(row.modelSpec, usage);
			totalCost += cost;
			totals.inputTokens += usage.inputTokens;
			totals.outputTokens += usage.outputTokens;
			totals.cacheReadTokens += usage.cacheReadTokens;
			totals.cacheCreateTokens += usage.cacheCreateTokens;
			byModel.push({ model: row.modelSpec ?? "unknown", ...usage, cost });
		}

		byModel.sort((a, b) => b.cost - a.cost);

		const totalTokens =
			totals.inputTokens +
			totals.outputTokens +
			totals.cacheReadTokens +
			totals.cacheCreateTokens;
		const cacheablePrompt = totals.inputTokens + totals.cacheReadTokens;
		const cacheHitPct =
			cacheablePrompt > 0
				? Math.round((totals.cacheReadTokens / cacheablePrompt) * 100)
				: null;

		return {
			totals: { ...totals, totalTokens },
			cacheHitPct,
			totalCost,
			totalCostLabel: this.deps.pricing.formatCurrency(totalCost),
			byModel,
		};
	}
}
