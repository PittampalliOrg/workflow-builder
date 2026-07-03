export type AxisName =
	| "agent"
	| "agentVersion"
	| "model"
	| "modelLabel"
	| "mcpServerNames"
	| "skillNames"
	| "hookNames"
	| "pluginNames"
	| "maxTurns"
	| "concurrency"
	| "evaluationConcurrency"
	| "evaluatorResourceClass";

export type RunConfigSummary = {
	runId: string;
	suiteSlug: string;
	suiteName: string;
	createdAt: string;
	agent: { id: string; slug: string | null; name: string };
	agentVersion: number;
	model: string;
	modelLabel: string | null;
	mcpServerNames: string[];
	skillNames: string[];
	hookNames: string[];
	pluginNames: string[];
	maxTurns: number | null;
	concurrency: number;
	evaluationConcurrency: number;
	evaluatorResourceClass: string;
	resolved: number;
	total: number;
	resolvedRate: number;
	status: string;
};

export type AxisDiff = Record<
	AxisName,
	{
		differs: boolean;
		values: unknown[];
	}
>;

export type InstanceCell = {
	status: string;
	resolved: boolean;
	durationMs: number | null;
	tokens: number | null;
	error: string | null;
	sessionId: string | null;
};

export type RegressionMetric =
	| "resolved_rate"
	| "cost_per_resolved"
	| "turn_count_p50"
	| "tokens_p50"
	| "ttft_p50"
	| "tool_call_count_p50";

export type RegressionTestKind = "fisher_exact" | "welch_t";

export type RegressionTest = {
	metric: RegressionMetric;
	kind: RegressionTestKind;
	baseline: { mean: number; n: number; ci95: [number, number] | null };
	candidate: { mean: number; n: number; ci95: [number, number] | null };
	delta: number;
	pValue: number;
	significant: boolean;
	direction: "better" | "worse" | "neutral";
};

export type CompareData = {
	runs: RunConfigSummary[];
	axisDiff: AxisDiff;
	grid: Record<string, Record<string, InstanceCell>>;
	allInstanceIds: string[];
	sharedInstanceIds: string[];
	disagreements: string[];
	regression: RegressionTest[][];
};
