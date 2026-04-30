// Phase J — pure cohort-pivot helper. Lives outside $lib/server so the
// CohortPivot Svelte component can import the types + pivot function for
// client-side bar-chart rendering. Server-side `stats.ts` re-exports these
// alongside the benchmark aggregates.

export type CohortRow = {
	resolved: boolean;
	repo: string | null;
	difficulty: string | null;
	status: string;
	terminationReason: string | null;
	primaryTool: string | null;
	costUsd: number | null;
	turnCount: number | null;
	tokens: number | null;
	ttftMs: number | null;
	inferenceMs: number | null;
};

export type CohortDimension =
	| "repo"
	| "difficulty"
	| "status"
	| "termination_reason"
	| "primary_tool";

export type CohortMeasure =
	| "resolved_rate"
	| "count"
	| "cost_usd_mean"
	| "cost_per_resolved"
	| "turn_count_p50"
	| "tokens_p50"
	| "ttft_p50"
	| "inference_ms_p50";

export type PivotBucket = {
	dimension: string;
	count: number;
	value: number | null;
};

export const COHORT_DIMENSIONS: { id: CohortDimension; label: string }[] = [
	{ id: "repo", label: "Repo" },
	{ id: "difficulty", label: "Difficulty" },
	{ id: "status", label: "Status" },
	{ id: "termination_reason", label: "Termination reason" },
	{ id: "primary_tool", label: "Primary tool" },
];

export const COHORT_MEASURES: {
	id: CohortMeasure;
	label: string;
	format: "pct" | "count" | "usd" | "tokens" | "ms";
}[] = [
	{ id: "resolved_rate", label: "Resolved rate", format: "pct" },
	{ id: "count", label: "Count", format: "count" },
	{ id: "cost_usd_mean", label: "Cost (mean)", format: "usd" },
	{ id: "cost_per_resolved", label: "Cost / resolved", format: "usd" },
	{ id: "turn_count_p50", label: "Turns (p50)", format: "count" },
	{ id: "tokens_p50", label: "Tokens (p50)", format: "tokens" },
	{ id: "ttft_p50", label: "TTFT (p50, ms)", format: "ms" },
	{ id: "inference_ms_p50", label: "Inference (p50, ms)", format: "ms" },
];

function dimensionValue(row: CohortRow, dim: CohortDimension): string {
	switch (dim) {
		case "repo":
			return row.repo ?? "unknown";
		case "difficulty":
			return row.difficulty ?? "(none)";
		case "status":
			return row.status;
		case "termination_reason":
			return row.terminationReason ?? "(none)";
		case "primary_tool":
			return row.primaryTool ?? "(none)";
	}
}

function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
	return sorted[idx];
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return percentile(sorted, 0.5);
}

export function pivot(
	rows: CohortRow[],
	dimension: CohortDimension,
	measure: CohortMeasure,
): PivotBucket[] {
	const groups = new Map<string, CohortRow[]>();
	for (const row of rows) {
		const key = dimensionValue(row, dimension);
		const arr = groups.get(key);
		if (arr) arr.push(row);
		else groups.set(key, [row]);
	}
	const result: PivotBucket[] = [];
	for (const [key, items] of groups.entries()) {
		const count = items.length;
		let value: number | null = 0;
		switch (measure) {
			case "resolved_rate": {
				const r = items.filter((i) => i.resolved).length;
				value = count > 0 ? r / count : null;
				break;
			}
			case "count":
				value = count;
				break;
			case "cost_usd_mean": {
				const xs = items
					.map((i) => i.costUsd)
					.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
				value = xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
				break;
			}
			case "cost_per_resolved": {
				const totalCost = items
					.map((i) => i.costUsd ?? 0)
					.reduce((a, b) => a + b, 0);
				const resolvedCount = items.filter((i) => i.resolved).length;
				value = resolvedCount > 0 ? totalCost / resolvedCount : null;
				break;
			}
			case "turn_count_p50": {
				const xs = items
					.map((i) => i.turnCount)
					.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
				value = median(xs);
				break;
			}
			case "tokens_p50": {
				const xs = items
					.map((i) => i.tokens)
					.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
				value = median(xs);
				break;
			}
			case "ttft_p50": {
				const xs = items
					.map((i) => i.ttftMs)
					.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
				value = median(xs);
				break;
			}
			case "inference_ms_p50": {
				const xs = items
					.map((i) => i.inferenceMs)
					.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
				value = median(xs);
				break;
			}
		}
		result.push({ dimension: key, count, value });
	}
	result.sort((a, b) => {
		if (a.value === null && b.value === null) return b.count - a.count;
		if (a.value === null) return 1;
		if (b.value === null) return -1;
		return b.value - a.value || b.count - a.count;
	});
	return result;
}
